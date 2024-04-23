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

const VALID_EVENT_NAMES = ['pull_request', 'pull_request_target']

interface IPullRequest {
  [key: string]: any
  number: number
  html_url?: string | undefined
  body?: string | undefined
}

interface IFile {
  sha: string
  filename: string
  status:
    | 'added'
    | 'removed'
    | 'modified'
    | 'renamed'
    | 'copied'
    | 'changed'
    | 'unchanged'
  additions: number
  deletions: number
  changes: number
  blob_url: string
  raw_url: string
  contents_url: string
  patch?: string | undefined
  previous_filename?: string | undefined
}

/**
 * 要約の結果
 * @property {string} 0 - ファイル名
 * @property {string} 1 - 要約
 * @property {boolean} 2 - レビューが必要かどうか
 */
type TSummaryResult = [string, string, boolean]
const SUMMARY_RESULT = {
  FILENAME: 0,
  SUMMARY: 1,
  NEEDS_REVIEW: 2
} as const

/**
 * Githubから取得したパッチ
 * @property {number} 0 - パッチの開始行
 * @property {number} 1 - パッチの終了行
 * @property {string} 2 - パッチの内容
 */
type TPatch = [number, number, string]
const PATCH = {
  START_LINE: 0,
  END_LINE: 1,
  CONTENT: 2
} as const

/**
 * Githubのファイルと変更内容
 * @property {string} 0 - ファイル名
 * @property {string} 1 - ファイルコンテンツ
 * @property {string} 2 - ファイルの変更内容
 * @property {TPatch[]} 3 - パッチ
 */
type TFilesAndChanges = [string, string, string, TPatch[]]

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

  const isValidInput = __validateInputAndInjectPRMeta({inputs})
  if (!isValidInput) return
  const pullRequest = context.payload.pull_request as IPullRequest

  // gpt-3.5-turboはシステム・メッセージに注意を払わないので、とりあえずinputsに追加する。
  // TODO: ちょっと何を言っているのかわからないので、後で確認
  inputs.systemMessage = options.systemMessage
  const {existingCommitIdsBlock, rawSummary, shortSummary} = await __getPreview(
    {commenter, pullRequest}
  )
  inputs.rawSummary = rawSummary
  inputs.shortSummary = shortSummary

  const highestReviewedCommitId = await __getHighestReviewedCommitId({
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

  const {filterSelectedFiles} = __filterSelectedFiles({files, options})

  if (filterSelectedFiles.length === 0) {
    warning('Skipped: filterSelectedFiles is null')
    return
  }

  const commits = incrementalDiff.data.commits

  if (commits.length === 0) {
    warning('Skipped: commits is null')
    return
  }

  // レビューのため、hunksを取得する
  const filteredFiles: (TFilesAndChanges | null)[] = await Promise.all(
    filterSelectedFiles.map(file =>
      githubConcurrencyLimit(async () => {
        return __retrieveFileContents({file, pullRequest})
      })
    )
  )

  // 取得したファイルが空の場合は除外する
  const filesAndChanges = filteredFiles.filter(
    file => file !== null
  ) as TFilesAndChanges[]

  // レビューできるファイルがない場合はスキップする
  if (filesAndChanges.length === 0) {
    error('Skipped: no files to review')
    return
  }

  // ファイルの変更を要約し、レビューが必要かどうかを判定する
  const summaryPromises = []
  const skippedFiles = []
  for (const [filename, fileDiff] of filesAndChanges) {
    if (options.maxFiles <= 0 || summaryPromises.length < options.maxFiles) {
      summaryPromises.push(
        openaiConcurrencyLimit(
          async () =>
            await __doSummary({
              filename,
              fileDiff,
              options,
              inputs,
              prompts,
              lightBot
            })
        )
      )
    } else {
      skippedFiles.push(filename)
    }
  }

  const summaryResults = await Promise.all(summaryPromises)
  const summaries = summaryResults.filter(
    summary => summary !== null
  ) as TSummaryResult[]

  if (summaries.length > 0) {
    const BATCH_SIZE = 10
    // サマリーをBATCH_SIZEのバッチにまとめ、ボットに要約を依頼する
    for (let i = 0; i < summaries.length; i += BATCH_SIZE) {
      const summariesBatch = summaries.slice(i, i + BATCH_SIZE)
      for (const [filename, summary] of summariesBatch) {
        inputs.rawSummary += `---
${filename}: ${summary}
`
      }
      // chatgptに要約を依頼する
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

  // 最終版の要約
  const [summarizeFinalResponse] = await heavyBot.chat(
    prompts.renderSummarize(inputs),
    {}
  )
  if (summarizeFinalResponse === '') {
    info('summarize: nothing obtained from openai')
  }

  if (options.disableReleaseNotes === false) {
    // 最終版リリースノート
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
        await commenter.updateDescription(pullRequest.number, message)
      } catch (e: any) {
        warning(`release notes: error from github: ${e.message as string}`)
      }
    }
  }

  // 短い要約も生成する
  const [summarizeShortResponse] = await heavyBot.chat(
    prompts.renderSummarizeShort(inputs),
    {}
  )
  inputs.shortSummary = summarizeShortResponse

  let summarizeComment = __generateSummarizeComment({
    summarizeFinalResponse,
    rawSummary: inputs.rawSummary,
    shortSummary: inputs.shortSummary
  })

  if (!options.disableReview) {
    const filesAndChangesReview = filesAndChanges.filter(([filename]) => {
      return __checkIsNeedReview({filename, summaries})
    })

    const reviewPromises = []
    for (const [filename, , , patches] of filesAndChangesReview) {
      if (options.maxFiles <= 0 || reviewPromises.length < options.maxFiles) {
        reviewPromises.push(
          openaiConcurrencyLimit(async () => {
            await doReview({
              filename,
              patches,
              inputs,
              prompts,
              heavyBot,
              options,
              pullRequest,
              commenter
            })
          })
        )
      } else {
        skippedFiles.push(filename)
      }
    }

    await Promise.all(reviewPromises)

    // 既存のコメントIDブロックに最新のhead shaを追加する。
    summarizeComment += `\n${commenter.addReviewedCommitId(
      existingCommitIdsBlock,
      pullRequest.head.sha
    )}`

    // レビューを投稿する
    await commenter.submitReview(
      pullRequest.number,
      commits[commits.length - 1].sha
    )
  }

  // サマリーのコメントを投稿する
  await commenter.comment(`${summarizeComment}`, SUMMARIZE_TAG, 'replace')
}

const __splitPatch = (patch: string | null | undefined): string[] => {
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

const __validateInputAndInjectPRMeta = ({inputs}: {inputs: Inputs}) => {
  if (!VALID_EVENT_NAMES.includes(context.eventName)) {
    warning(
      `Skipped: current event is ${context.eventName}, only support pull_request event`
    )
    return false
  }
  if (context.payload.pull_request == null) {
    warning('Skipped: context.payload.pull_request is null')
    return false
  }

  inputs.title = context.payload.pull_request.title
  if (context.payload.pull_request.body != null) {
    // FIXME: 2024/04 コスト削減のため、PRの説明を取得する処理をコメントアウトした
    // inputs.description = commenter.getDescription(
    //   context.payload.pull_request.body
    // )
  }

  // 説明文にignore_keywordが含まれている場合はスキップする。
  if (inputs.description.includes(ignoreKeyword)) {
    info('Skipped: description contains ignore_keyword')
    return false
  }

  return true
}

const __getPreview = async ({
  commenter,
  pullRequest
}: {
  commenter: Commenter
  pullRequest: IPullRequest
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
  const existingCommitIdsBlock = commenter.getReviewedCommitIdsBlock(
    existingSummarizeCmtBody
  )
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
const __getHighestReviewedCommitId = async ({
  commenter,
  existingCommitIdsBlock,
  pullRequest
}: {
  commenter: Commenter
  existingCommitIdsBlock: string
  pullRequest: IPullRequest
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
    info(`Will review from the base commit: ${pullRequest.base.sha as string}`)
    highestReviewedCommitId = pullRequest.base.sha
  } else {
    info(`Will review from commit: ${highestReviewedCommitId}`)
  }

  return highestReviewedCommitId
}

/**
 * オプションに基づいてファイルをフィルタリングする
 * @param files フィルタリングするファイル
 * @param options オプション
 */
const __filterSelectedFiles = ({
  files,
  options
}: {
  files: IFile[]
  options: Options
}) => {
  // フィルタリングされたファイルをスキップする
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

  return {
    filterSelectedFiles,
    filterIgnoredFiles
  }
}

const __retrieveFileContents = async ({
  file,
  pullRequest
}: {
  file: IFile
  pullRequest: IPullRequest
}) => {
  let fileContent = ''
  if (pullRequest == null) {
    warning('Skipped: context.payload.pull_request is null')
    return null
  }
  try {
    // ベースブランチのファイルコンテンツを取得する
    const contents = await octokit.repos.getContent({
      owner: repo.owner,
      repo: repo.repo,
      path: file.filename,
      ref: pullRequest.base.sha
    })
    if (contents.data != null) {
      if (!Array.isArray(contents.data)) {
        if (contents.data.type === 'file' && contents.data.content != null) {
          fileContent = Buffer.from(contents.data.content, 'base64').toString()
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

  const patches: TPatch[] = []
  for (const patch of __splitPatch(file.patch)) {
    const patchLines = __patchStartEndLine(patch)
    if (patchLines == null) {
      continue
    }
    const hunks = __parsePatch(patch)
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
    return [file.filename, fileContent, fileDiff, patches] as TFilesAndChanges
  } else {
    return null
  }
}

const __patchStartEndLine = (
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

const __parsePatch = (
  patch: string
): {oldHunk: string; newHunk: string} | null => {
  const hunkInfo = __patchStartEndLine(patch)
  if (hunkInfo == null) {
    return null
  }

  const oldHunkLines: string[] = []
  const newHunkLines: string[] = []

  let newLine = hunkInfo.newHunk.startLine

  const lines = patch.split('\n').slice(1) // @@ の行をスキップする

  // 最後の行が空の場合は削除する
  if (lines[lines.length - 1] === '') {
    lines.pop()
  }

  // 最初の3行と最後の3行の注釈をスキップする。
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

function __parseReview(
  response: string,
  patches: TPatch[],
  debug = false
): Review[] {
  const reviews: Review[] = []

  response = __sanitizeResponse(response.trim())

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
          review.startLine = patches[0][PATCH.START_LINE]
          review.endLine = patches[0][PATCH.END_LINE]
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

const __sanitizeResponse = (comment: string): string => {
  comment = __sanitizeCodeBlock(comment, 'suggestion')
  comment = __sanitizeCodeBlock(comment, 'diff')
  return comment
}

const __sanitizeCodeBlock = (
  comment: string,
  codeBlockLabel: string
): string => {
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
const __doSummary = async ({
  filename,
  fileDiff,
  options,
  inputs,
  prompts,
  lightBot
}: {
  filename: string
  fileDiff: string
  options: Options
  inputs: Inputs
  prompts: Prompts
  lightBot: Bot
}): Promise<TSummaryResult | null> => {
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
      // 変更がレビューを必要とする場合はtrue、それ以外はfalseを返す
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

const doReview = async ({
  filename,
  patches,
  inputs,
  prompts,
  heavyBot,
  options,
  pullRequest,
  commenter
}: {
  filename: string
  patches: Array<[number, number, string]>
  inputs: Inputs
  prompts: Prompts
  heavyBot: Bot
  options: Options
  pullRequest: IPullRequest
  commenter: Commenter
}): Promise<void> => {
  info(`reviewing ${filename}`)
  const reviewsFailed: string[] = []
  // インプットのコピーを作成する
  const ins: Inputs = inputs.clone()
  ins.filename = filename

  // これまでの入力に基づいてトークンを計算する
  let tokens = getTokenCount(prompts.renderReviewFileDiff(ins))
  // パッチトークンの合計を計算するループ
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
    // このリクエストにもっと多くのパッチを詰め込めるかどうか見てみよう
    // TODO: ちょっと何を言っているのかわからないので、後で確認
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
    // comment_chainをこのリクエストに詰め込んでみる
    const commentChainTokens = getTokenCount(commentChain)
    if (tokens + commentChainTokens > options.heavyTokenLimits.requestTokens) {
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
    // レビューを行う
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
      // レビューを解析する
      const reviews = __parseReview(response, patches, options.debug)
      for (const review of reviews) {
        // LGTMかどうか確認する
        if (
          !options.reviewCommentLGTM &&
          // スキップ対象の文言が含まれていた場合はスキップする
          SKIP_KEYWORDS.some(keyword => review.comment.includes(keyword))
        ) {
          continue
        }
        if (pullRequest == null) {
          warning('No pull request found, skipping.')
          continue
        }

        try {
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
  }
}

const __generateSummarizeComment = ({
  summarizeFinalResponse,
  rawSummary,
  shortSummary
}: {
  summarizeFinalResponse: string
  rawSummary: string
  shortSummary: string
}) => {
  return `${summarizeFinalResponse}
${RAW_SUMMARY_START_TAG}
${rawSummary}
${RAW_SUMMARY_END_TAG}
${SHORT_SUMMARY_START_TAG}
${shortSummary}
${SHORT_SUMMARY_END_TAG}

---
`
}

const __checkIsNeedReview = ({
  filename,
  summaries
}: {
  filename: string
  summaries: TSummaryResult[]
}) => {
  const summary = summaries.find(
    ([summaryFilename]) => summaryFilename === filename
  )
  return summary?.[SUMMARY_RESULT.NEEDS_REVIEW] ?? true
}
