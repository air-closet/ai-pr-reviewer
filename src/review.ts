import {error, info, warning} from '@actions/core'
// eslint-disable-next-line camelcase
import {context as github_context} from '@actions/github'
import pLimit from 'p-limit'
import {type Bot} from './bot'
import {
  Commenter,
  COMMENT_REPLY_TAG,
  RAW_SUMMARY_END_TAG,
  RAW_SUMMARY_START_TAG,
  SHORT_SUMMARY_END_TAG,
  SHORT_SUMMARY_START_TAG,
  SUMMARIZE_TAG
} from './commenter'
import {Inputs} from './inputs'
import {octokit} from './octokit'
import {type Options} from './options'
import {type Prompts} from './prompts'
import {getTokenCount} from './tokenizer'

// eslint-disable-next-line camelcase
const context = github_context
const repo = context.repo

const ignoreKeyword = '@coderabbitai: ignore'

// レビューに含まれていた場合にスキップする文言のリスト
const SKIP_KEYWORDS = [
  // 変更に対する賞賛
  'LGTM',
  'looks good to me',
  '問題ありません。',
  '問題はありません。',
  '問題は見受けられません。',
  '変更も適切です。',
  '変更は適切です。',
  '適切な変更です。',
  'この変更は推奨されます。',
  '良い変更です。',
  '必要な修正です。',
  '必要な変更です。',
  '改善です。',
  'コードの可読性を向上させます。',
  '機能が強化されます。',
  // 抽象的なコメント
  '確認してください。',
  '使用されていないようです。',
  // コメントアウトに対するコメント
  'コメントアウト',
  '具体的な実装がありません。',
  '実装がまだ完了していないようです。',
  '不要なインポート',
  // ドキュメントの不足に対するコメント
  'コメントがないようです。',
  '説明がありません。',
  '説明が不足しています。',
  '説明されていません。',
  '説明が必要です。'
]

const VALID_EVENT_NAMES = [
  'pull_request',
  'pull_request_target',
]

interface IPullRequest {
  [key: string]: any;
  number: number;
  html_url?: string | undefined;
  body?: string | undefined;
}

export const codeReview = async (
  lightBot: Bot,
  heavyBot: Bot,
  options: Options,
  prompts: Prompts
): Promise<void> => {
  const commenter: Commenter = new Commenter()

  const openaiConcurrencyLimit = pLimit(options.openaiConcurrencyLimit)
  const githubConcurrencyLimit = pLimit(options.githubConcurrencyLimit)
  const inputs: Inputs = new Inputs()

  const isValidInput = _checkIsValidInput({ inputs, commenter })
  if (!isValidInput) return;
  const pullRequest = context.payload.pull_request as IPullRequest

  // gpt-3.5-turboはシステム・メッセージに注意を払わないので、とりあえずinputsに追加する。
  inputs.systemMessage = options.systemMessage
  const {
    existingCommitIdsBlock,
    rawSummary,
    shortSummary
  } = await getPreview({ commenter, pullRequest });
  inputs.rawSummary = rawSummary
  inputs.shortSummary = shortSummary

  const highestReviewedCommitId = await getHighestReviewedCommitId({
    commenter,
    existingCommitIdsBlock,
    pullRequest
  })

  // PR ブランチの最後にレビューしたコミットと最新コミットの diff を取得する
  const incrementalDiff = await octokit.repos.compareCommits({
    owner: repo.owner,
    repo: repo.repo,
    base: highestReviewedCommitId,
    head: pullRequest.head.sha
  })

  // ターゲットブランチのベースコミットと PR ブランチの最新コミットの diff を取得する
  const targetBranchDiff = await octokit.repos.compareCommits({
    owner: repo.owner,
    repo: repo.repo,
    base: pullRequest.base.sha,
    head: pullRequest.head.sha
  })

  // PR ブランチの最後にレビューしたコミットと最新コミットの diff、つまりプッシュされた増分
  const incrementalFiles = incrementalDiff.data.files
  // ターゲットブランチのベースコミットと PR ブランチの最新コミットの diff、つまり PR ブランチの変更内容
  const targetBranchFiles = targetBranchDiff.data.files

  if (incrementalFiles == null || targetBranchFiles == null) {
    warning('Skipped: files data is missing')
    return
  }

  // 増分の変更と比較して変更されたファイルをフィルタリングする。
  // これにより、前回のレビュー以降に変更されたファイルのみが残る。
  const files = targetBranchFiles.filter(targetBranchFile =>
    incrementalFiles.some(
      incrementalFile => incrementalFile.filename === targetBranchFile.filename
    )
  )

  if (files.length === 0) {
    warning('Skipped: files is null')
    return
  }

  // skip files if they are filtered out
  const filterSelectedFiles = []
  const filterIgnoredFiles = []
  for (const file of files) {
    if (!options.checkPath(file.filename)) {
      info(`skip for excluded path: ${file.filename}`)
      filterIgnoredFiles.push(file)
    } else {
      filterSelectedFiles.push(file)
    }
  }

  if (filterSelectedFiles.length === 0) {
    warning('Skipped: filterSelectedFiles is null')
    return
  }

  const commits = incrementalDiff.data.commits

  if (commits.length === 0) {
    warning('Skipped: commits is null')
    return
  }

  // find hunks to review
  const filteredFiles: Array<
    [string, string, string, Array<[number, number, string]>] | null
  > = await Promise.all(
    filterSelectedFiles.map(file =>
      githubConcurrencyLimit(async () => {
        // retrieve file contents
        let fileContent = ''
        if (pullRequest == null) {
          warning('Skipped: context.payload.pull_request is null')
          return null
        }
        try {
          const contents = await octokit.repos.getContent({
            owner: repo.owner,
            repo: repo.repo,
            path: file.filename,
            ref: pullRequest.base.sha
          })
          if (contents.data != null) {
            if (!Array.isArray(contents.data)) {
              if (
                contents.data.type === 'file' &&
                contents.data.content != null
              ) {
                fileContent = Buffer.from(
                  contents.data.content,
                  'base64'
                ).toString()
              }
            }
          }
        } catch (e: any) {
          warning(
            `Failed to get file contents: ${
              e as string
            }. This is OK if it's a new file.`
          )
        }

        let fileDiff = ''
        if (file.patch != null) {
          fileDiff = file.patch
        }

        const patches: Array<[number, number, string]> = []
        for (const patch of splitPatch(file.patch)) {
          const patchLines = patchStartEndLine(patch)
          if (patchLines == null) {
            continue
          }
          const hunks = parsePatch(patch)
          if (hunks == null) {
            continue
          }
          const hunksStr = `
---new_hunk---
\`\`\`
${hunks.newHunk}
\`\`\`

---old_hunk---
\`\`\`
${hunks.oldHunk}
\`\`\`
`
          patches.push([
            patchLines.newHunk.startLine,
            patchLines.newHunk.endLine,
            hunksStr
          ])
        }
        if (patches.length > 0) {
          return [file.filename, fileContent, fileDiff, patches] as [
            string,
            string,
            string,
            Array<[number, number, string]>
          ]
        } else {
          return null
        }
      })
    )
  )

  // Filter out any null results
  const filesAndChanges = filteredFiles.filter(file => file !== null) as Array<
    [string, string, string, Array<[number, number, string]>]
  >

  if (filesAndChanges.length === 0) {
    error('Skipped: no files to review')
    return
  }

  const summaryPromises = []
  const skippedFiles = []
  for (const [filename, fileDiff] of filesAndChanges) {
    if (options.maxFiles <= 0 || summaryPromises.length < options.maxFiles) {
      summaryPromises.push(
        openaiConcurrencyLimit(
          async () => await doSummary({ filename, fileDiff, options, inputs, prompts, lightBot })
        )
      )
    } else {
      skippedFiles.push(filename)
    }
  }

  const summaryResults = await Promise.all(summaryPromises);
  const summaries = summaryResults.filter(
    summary => summary !== null
  ) as Array<[string, string, boolean]>

  if (summaries.length > 0) {
    const BATCH_SIZE = 10
    // join summaries into one in the batches of BATCH_SIZE
    // and ask the bot to summarize the summaries
    for (let i = 0; i < summaries.length; i += BATCH_SIZE) {
      const summariesBatch = summaries.slice(i, i + BATCH_SIZE)
      for (const [filename, summary] of summariesBatch) {
        inputs.rawSummary += `---
${filename}: ${summary}
`
      }
      // ask chatgpt to summarize the summaries
      const [summarizeResp] = await heavyBot.chat(
        prompts.renderSummarizeChangesets(inputs),
        {}
      )
      if (summarizeResp === '') {
        warning('summarize: nothing obtained from openai')
      } else {
        inputs.rawSummary = summarizeResp
      }
    }
  }

  // final summary
  const [summarizeFinalResponse] = await heavyBot.chat(
    prompts.renderSummarize(inputs),
    {}
  )
  if (summarizeFinalResponse === '') {
    info('summarize: nothing obtained from openai')
  }

  if (options.disableReleaseNotes === false) {
    // final release notes
    const [releaseNotesResponse] = await heavyBot.chat(
      prompts.renderSummarizeReleaseNotes(inputs),
      {}
    )
    if (releaseNotesResponse === '') {
      info('release notes: nothing obtained from openai')
    } else {
      let message = '### Summary by CodeRabbit\n\n'
      message += releaseNotesResponse
      try {
        await commenter.updateDescription(
          pullRequest.number,
          message
        )
      } catch (e: any) {
        warning(`release notes: error from github: ${e.message as string}`)
      }
    }
  }

  // generate a short summary as well
  const [summarizeShortResponse] = await heavyBot.chat(
    prompts.renderSummarizeShort(inputs),
    {}
  )
  inputs.shortSummary = summarizeShortResponse

  let summarizeComment = `${summarizeFinalResponse}
${RAW_SUMMARY_START_TAG}
${inputs.rawSummary}
${RAW_SUMMARY_END_TAG}
${SHORT_SUMMARY_START_TAG}
${inputs.shortSummary}
${SHORT_SUMMARY_END_TAG}

---

`

  if (!options.disableReview) {
    const filesAndChangesReview = filesAndChanges.filter(([filename]) => {
      const needsReview =
        summaries.find(
          ([summaryFilename]) => summaryFilename === filename
        )?.[2] ?? true
      return needsReview
    })

    const reviewsSkipped = filesAndChanges
      .filter(
        ([filename]) =>
          !filesAndChangesReview.some(
            ([reviewFilename]) => reviewFilename === filename
          )
      )
      .map(([filename]) => filename)

    // failed reviews array
    const reviewsFailed: string[] = []
    const doReview = async (
      filename: string,
      fileContent: string,
      patches: Array<[number, number, string]>
    ): Promise<void> => {
      info(`reviewing ${filename}`)
      // make a copy of inputs
      const ins: Inputs = inputs.clone()
      ins.filename = filename

      // calculate tokens based on inputs so far
      let tokens = getTokenCount(prompts.renderReviewFileDiff(ins))
      // loop to calculate total patch tokens
      let patchesToPack = 0
      for (const [, , patch] of patches) {
        const patchTokens = getTokenCount(patch)
        if (tokens + patchTokens > options.heavyTokenLimits.requestTokens) {
          info(
            `only packing ${patchesToPack} / ${patches.length} patches, tokens: ${tokens} / ${options.heavyTokenLimits.requestTokens}`
          )
          break
        }
        tokens += patchTokens
        patchesToPack += 1
      }

      let patchesPacked = 0
      for (const [startLine, endLine, patch] of patches) {
        if (pullRequest == null) {
          warning('No pull request found, skipping.')
          continue
        }
        // see if we can pack more patches into this request
        if (patchesPacked >= patchesToPack) {
          info(
            `unable to pack more patches into this request, packed: ${patchesPacked}, total patches: ${patches.length}, skipping.`
          )
          if (options.debug) {
            info(`prompt so far: ${prompts.renderReviewFileDiff(ins)}`)
          }
          break
        }
        patchesPacked += 1

        let commentChain = ''
        try {
          const allChains = await commenter.getCommentChainsWithinRange(
            pullRequest.number,
            filename,
            startLine,
            endLine,
            COMMENT_REPLY_TAG
          )

          if (allChains.length > 0) {
            info(`Found comment chains: ${allChains} for ${filename}`)
            commentChain = allChains
          }
        } catch (e: any) {
          warning(
            `Failed to get comments: ${e as string}, skipping. backtrace: ${
              e.stack as string
            }`
          )
        }
        // try packing comment_chain into this request
        const commentChainTokens = getTokenCount(commentChain)
        if (
          tokens + commentChainTokens >
          options.heavyTokenLimits.requestTokens
        ) {
          commentChain = ''
        } else {
          tokens += commentChainTokens
        }

        ins.patches += `
${patch}
`
        if (commentChain !== '') {
          ins.patches += `
---comment_chains---
\`\`\`
${commentChain}
\`\`\`
`
        }

        ins.patches += `
---end_change_section---
`
      }

      if (patchesPacked > 0) {
        // perform review
        try {
          const [response] = await heavyBot.chat(
            prompts.renderReviewFileDiff(ins),
            {}
          )
          if (response === '') {
            info('review: nothing obtained from openai')
            reviewsFailed.push(`${filename} (no response)`)
            return
          }
          // parse review
          const reviews = parseReview(response, patches, options.debug)
          for (const review of reviews) {
            // check for LGTM
            if (
              !options.reviewCommentLGTM &&
              // スキップ対象の文言が含まれていた場合はスキップする
              SKIP_KEYWORDS.some(keyword => review.comment.includes(keyword))
            ) {
              // lgtmCount += 1
              continue
            }
            if (pullRequest == null) {
              warning('No pull request found, skipping.')
              continue
            }

            try {
              // reviewCount += 1
              await commenter.bufferReviewComment(
                filename,
                review.startLine,
                review.endLine,
                `${review.comment}`
              )
            } catch (e: any) {
              reviewsFailed.push(`${filename} comment failed (${e as string})`)
            }
          }
        } catch (e: any) {
          warning(
            `Failed to review: ${e as string}, skipping. backtrace: ${
              e.stack as string
            }`
          )
          reviewsFailed.push(`${filename} (${e as string})`)
        }
      } else {
        reviewsSkipped.push(`${filename} (diff too large)`)
      }
    }

    const reviewPromises = []
    for (const [filename, fileContent, , patches] of filesAndChangesReview) {
      if (options.maxFiles <= 0 || reviewPromises.length < options.maxFiles) {
        reviewPromises.push(
          openaiConcurrencyLimit(async () => {
            await doReview(filename, fileContent, patches)
          })
        )
      } else {
        skippedFiles.push(filename)
      }
    }

    await Promise.all(reviewPromises)

    // add existing_comment_ids_block with latest head sha
    summarizeComment += `\n${commenter.addReviewedCommitId(
      existingCommitIdsBlock,
      pullRequest.head.sha
    )}`

    // post the review
    await commenter.submitReview(
      pullRequest.number,
      commits[commits.length - 1].sha
    )
  }

  // post the final summary comment
  await commenter.comment(`${summarizeComment}`, SUMMARIZE_TAG, 'replace')
}

const splitPatch = (patch: string | null | undefined): string[] => {
  if (patch == null) {
    return []
  }

  const pattern = /(^@@ -(\d+),(\d+) \+(\d+),(\d+) @@).*$/gm

  const result: string[] = []
  let last = -1
  let match: RegExpExecArray | null
  while ((match = pattern.exec(patch)) !== null) {
    if (last === -1) {
      last = match.index
    } else {
      result.push(patch.substring(last, match.index))
      last = match.index
    }
  }
  if (last !== -1) {
    result.push(patch.substring(last))
  }
  return result
}

const _checkIsValidInput = ({ inputs, commenter }: {
  inputs: Inputs;
  commenter: Commenter;
}) => {
  if (!VALID_EVENT_NAMES.includes(context.eventName)) {
    warning(
      `Skipped: current event is ${context.eventName}, only support pull_request event`
    )
    return false;
  }
  if (context.payload.pull_request == null) {
    warning('Skipped: context.payload.pull_request is null')
    return false;
  }

  inputs.title = context.payload.pull_request.title
  if (context.payload.pull_request.body != null) {
    inputs.description = commenter.getDescription(
      context.payload.pull_request.body
    )
  }

  // if the description contains ignore_keyword, skip
  if (inputs.description.includes(ignoreKeyword)) {
    info('Skipped: description contains ignore_keyword')
    return false;
  }

  return true;
}

const getPreview = async({
  commenter,
  pullRequest
} : {
  commenter: Commenter;
  pullRequest: IPullRequest;
}) => {
  // SUMMARIZE_TAGメッセージを取得する
  const existingSummarizeCmt = await commenter.findCommentWithTag(
    SUMMARIZE_TAG,
    pullRequest.number
  )

  if (existingSummarizeCmt == null) {
    return {
      existingCommitIdsBlock: '',
      rawSummary: '',
      shortSummary: ''
    }
  }

  const existingSummarizeCmtBody = existingSummarizeCmt.body
  const existingCommitIdsBlock = commenter.getReviewedCommitIdsBlock(existingSummarizeCmtBody)
  const rawSummary = commenter.getRawSummary(existingSummarizeCmtBody)
  const shortSummary = commenter.getShortSummary(existingSummarizeCmtBody)
  return {
    existingCommitIdsBlock,
    rawSummary,
    shortSummary
  }
}

/**
 * 最後にレビューしたコミットIDを取得する
 */
const getHighestReviewedCommitId = async ({
  commenter,
  existingCommitIdsBlock,
  pullRequest
} : {
  commenter: Commenter;
  existingCommitIdsBlock: string;
  pullRequest: IPullRequest;
}) => {
  const allCommitIds = await commenter.getAllCommitIds()
  let highestReviewedCommitId = ''
  if (existingCommitIdsBlock !== '') {
    highestReviewedCommitId = commenter.getHighestReviewedCommitId(
      allCommitIds,
      commenter.getReviewedCommitIds(existingCommitIdsBlock)
    )
  }

  if (
    highestReviewedCommitId === '' ||
    highestReviewedCommitId === pullRequest.head.sha
  ) {
    info(
      `Will review from the base commit: ${
        pullRequest.base.sha as string
      }`
    )
    highestReviewedCommitId = pullRequest.base.sha
  } else {
    info(`Will review from commit: ${highestReviewedCommitId}`)
  }

  return highestReviewedCommitId
};

const patchStartEndLine = (
  patch: string
): {
  oldHunk: {startLine: number; endLine: number}
  newHunk: {startLine: number; endLine: number}
} | null => {
  const pattern = /(^@@ -(\d+),(\d+) \+(\d+),(\d+) @@)/gm
  const match = pattern.exec(patch)
  if (match != null) {
    const oldBegin = parseInt(match[2])
    const oldDiff = parseInt(match[3])
    const newBegin = parseInt(match[4])
    const newDiff = parseInt(match[5])
    return {
      oldHunk: {
        startLine: oldBegin,
        endLine: oldBegin + oldDiff - 1
      },
      newHunk: {
        startLine: newBegin,
        endLine: newBegin + newDiff - 1
      }
    }
  } else {
    return null
  }
}

const parsePatch = (
  patch: string
): {oldHunk: string; newHunk: string} | null => {
  const hunkInfo = patchStartEndLine(patch)
  if (hunkInfo == null) {
    return null
  }

  const oldHunkLines: string[] = []
  const newHunkLines: string[] = []

  let newLine = hunkInfo.newHunk.startLine

  const lines = patch.split('\n').slice(1) // Skip the @@ line

  // Remove the last line if it's empty
  if (lines[lines.length - 1] === '') {
    lines.pop()
  }

  // Skip annotations for the first 3 and last 3 lines
  const skipStart = 3
  const skipEnd = 3

  let currentLine = 0

  const removalOnly = !lines.some(line => line.startsWith('+'))

  for (const line of lines) {
    currentLine++
    if (line.startsWith('-')) {
      oldHunkLines.push(`${line.substring(1)}`)
    } else if (line.startsWith('+')) {
      newHunkLines.push(`${newLine}: ${line.substring(1)}`)
      newLine++
    } else {
      // context line
      oldHunkLines.push(`${line}`)
      if (
        removalOnly ||
        (currentLine > skipStart && currentLine <= lines.length - skipEnd)
      ) {
        newHunkLines.push(`${newLine}: ${line}`)
      } else {
        newHunkLines.push(`${line}`)
      }
      newLine++
    }
  }

  return {
    oldHunk: oldHunkLines.join('\n'),
    newHunk: newHunkLines.join('\n')
  }
}

interface Review {
  startLine: number
  endLine: number
  comment: string
}

function parseReview(
  response: string,
  patches: Array<[number, number, string]>,
  debug = false
): Review[] {
  const reviews: Review[] = []

  response = _sanitizeResponse(response.trim())

  const lines = response.split('\n')
  const lineNumberRangeRegex = /(?:^|\s)(\d+)-(\d+):\s*$/
  const commentSeparator = '---'

  let currentStartLine: number | null = null
  let currentEndLine: number | null = null
  let currentComment = ''
  function storeReview(): void {
    if (currentStartLine !== null && currentEndLine !== null) {
      const review: Review = {
        startLine: currentStartLine,
        endLine: currentEndLine,
        comment: currentComment
      }

      let withinPatch = false
      let bestPatchStartLine = -1
      let bestPatchEndLine = -1
      let maxIntersection = 0

      for (const [startLine, endLine] of patches) {
        const intersectionStart = Math.max(review.startLine, startLine)
        const intersectionEnd = Math.min(review.endLine, endLine)
        const intersectionLength = Math.max(
          0,
          intersectionEnd - intersectionStart + 1
        )

        if (intersectionLength > maxIntersection) {
          maxIntersection = intersectionLength
          bestPatchStartLine = startLine
          bestPatchEndLine = endLine
          withinPatch =
            intersectionLength === review.endLine - review.startLine + 1
        }

        if (withinPatch) break
      }

      if (!withinPatch) {
        if (bestPatchStartLine !== -1 && bestPatchEndLine !== -1) {
          review.comment = `> Note: This review was outside of the patch, so it was mapped to the patch with the greatest overlap. Original lines [${review.startLine}-${review.endLine}]

${review.comment}`
          review.startLine = bestPatchStartLine
          review.endLine = bestPatchEndLine
        } else {
          review.comment = `> Note: This review was outside of the patch, but no patch was found that overlapped with it. Original lines [${review.startLine}-${review.endLine}]

${review.comment}`
          review.startLine = patches[0][0]
          review.endLine = patches[0][1]
        }
      }

      reviews.push(review)

      info(
        `Stored comment for line range ${currentStartLine}-${currentEndLine}: ${currentComment.trim()}`
      )
    }
  }

  for (const line of lines) {
    const lineNumberRangeMatch = line.match(lineNumberRangeRegex)

    if (lineNumberRangeMatch != null) {
      storeReview()
      currentStartLine = parseInt(lineNumberRangeMatch[1], 10)
      currentEndLine = parseInt(lineNumberRangeMatch[2], 10)
      currentComment = ''
      if (debug) {
        info(`Found line number range: ${currentStartLine}-${currentEndLine}`)
      }
      continue
    }

    if (line.trim() === commentSeparator) {
      storeReview()
      currentStartLine = null
      currentEndLine = null
      currentComment = ''
      if (debug) {
        info('Found comment separator')
      }
      continue
    }

    if (currentStartLine !== null && currentEndLine !== null) {
      currentComment += `${line}\n`
    }
  }

  storeReview()

  return reviews
}

const _sanitizeResponse = (comment: string): string => {
  // TODO: 何がしたいのか理解できない
  comment = _sanitizeCodeBlock(comment, 'suggestion')
  comment = _sanitizeCodeBlock(comment, 'diff')
  return comment
}

const _sanitizeCodeBlock = (comment: string, codeBlockLabel: string): string => {
  const codeBlockStart = `\`\`\`${codeBlockLabel}`
  const codeBlockEnd = '```'
  const lineNumberRegex = /^ *(\d+): /gm

  let codeBlockStartIndex = comment.indexOf(codeBlockStart)

  while (codeBlockStartIndex !== -1) {
    const codeBlockEndIndex = comment.indexOf(
      codeBlockEnd,
      codeBlockStartIndex + codeBlockStart.length
    )

    if (codeBlockEndIndex === -1) break

    const codeBlock = comment.substring(
      codeBlockStartIndex + codeBlockStart.length,
      codeBlockEndIndex
    )
    const sanitizedBlock = codeBlock.replace(lineNumberRegex, '')

    comment =
      comment.slice(0, codeBlockStartIndex + codeBlockStart.length) +
      sanitizedBlock +
      comment.slice(codeBlockEndIndex)

    codeBlockStartIndex = comment.indexOf(
      codeBlockStart,
      codeBlockStartIndex +
        codeBlockStart.length +
        sanitizedBlock.length +
        codeBlockEnd.length
    )
  }

  return comment
}

/**
 * ファイルの変更内容を要約し、レビューが必要かどうかを判定する
 */
const doSummary = async ({
  filename,
  fileDiff,
  options,
  inputs,
  prompts,
  lightBot
} : {
  filename: string;
  fileDiff: string;
  options: Options;
  inputs: Inputs;
  prompts: Prompts;
  lightBot: Bot;
}): Promise<[string, string, boolean] | null> => {
  info(`summarize: ${filename}`)
  const ins = inputs.clone()
  if (fileDiff.length === 0) {
    warning(`summarize: file_diff is empty, skip ${filename}`)
    return null
  }

  ins.filename = filename
  ins.fileDiff = fileDiff

  // インプットに基づいてプロンプトをレンダリングする
  const summarizePrompt = prompts.renderSummarizeFileDiff(
    ins,
    options.reviewSimpleChanges
  )
  const tokens = getTokenCount(summarizePrompt)

  if (tokens > options.lightTokenLimits.requestTokens) {
    info(`summarize: diff tokens exceeds limit, skip ${filename}`)
    return null
  }

  // コンテキストを要約する
  try {
    const [summarizeResp] = await lightBot.chat(summarizePrompt, {})

    if (summarizeResp === '') {
      info('summarize: nothing obtained from openai')
      return null
    }

    if (options.reviewSimpleChanges === false) {
      // 分類をトリアージするためにコメントを解析する
      // フォーマットは: [TRIAGE]: <NEEDS_REVIEW or APPROVED>
      // 変更がレビューを必要とする場合はtrue、それ以外はfalseを返します。
      const triageRegex = /\[TRIAGE\]:\s*(NEEDS_REVIEW|APPROVED)/
      const triageMatch = summarizeResp.match(triageRegex)

      // TODO: 厳密等価演算子でなくていいのか確認
      if (triageMatch != null) {
        const triage = triageMatch[1]
        const needsReview = triage === 'NEEDS_REVIEW'

        // トリアージを削除して要約をトリミングする
        const summary = summarizeResp.replace(triageRegex, '').trim()
        info(`filename: ${filename}, triage: ${triage}`)
        return [filename, summary, needsReview]
      }
    }
    return [filename, summarizeResp, true]
  } catch (e: any) {
    warning(`summarize: error from openai: ${e as string}`)
    return null
  }
}
