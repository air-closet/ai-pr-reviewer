import pLimit from 'p-limit'
import {Bot} from './bot'
import {Commenter, SUMMARIZE_TAG} from './commenter'
import {Options} from './options'
import {Prompts} from './prompts'
import {context as githubContext} from '@actions/github'
import {warning} from '@actions/core'
import {error, info} from 'console'
import {WebhookPayload} from '@actions/github/lib/interfaces'
import {octokit} from './octokit'
import {SimpleInputs} from './simple-inputs'

interface ISimpleReviewConstructParams {
  lightBot: Bot
  heavyBot: Bot
  options: Options
  prompts: Prompts
}

type TContext = typeof githubContext
type IRepo = NonNullable<ReturnType<() => typeof githubContext.repo>>
type IPullRequest = NonNullable<WebhookPayload['pull_request']>

interface IContextHasValidPullRequest extends TContext {
  payload: {
    pull_request: IPullRequest
  }
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

interface Review {
  startLine: number
  endLine: number
  comment: string
}

const VALID_EVENT_NAMES = ['pull_request', 'pull_request_target']
const INVALID_TITLE_KEYWORDS = ["DON'T MERGE", "don't merge"]

export default class SimpleReview {
  private readonly lightBot: Bot
  private readonly heavyBot: Bot
  private readonly options: Options
  private readonly prompts: Prompts
  private readonly repo: IRepo
  private readonly pullRequest: IPullRequest

  constructor(params: ISimpleReviewConstructParams) {
    if (!SimpleReview.validateContext(githubContext)) {
      throw new Error('Context is invalid')
    }

    this.lightBot = params.lightBot
    this.heavyBot = params.heavyBot
    this.options = params.options
    this.prompts = params.prompts
    this.repo = githubContext.repo
    this.pullRequest = githubContext.payload.pull_request
  }

  public async run() {
    const commenter: Commenter = new Commenter()
    const inputs: SimpleInputs = new SimpleInputs()
    const openaiConcurrencyLimit = pLimit(this.options.openaiConcurrencyLimit)
    const githubConcurrencyLimit = pLimit(this.options.githubConcurrencyLimit)

    inputs.title = this.pullRequest.title
    inputs.systemMessage = this.options.systemMessage

    // TODO: diffを取る、みたいな抽象概念にして別の関数に切り出した方がいい_start
    const existingCommitIdsBlock = await this.getPreview({
      commenter,
      pullRequest: this.pullRequest
    })
    const highestReviewedCommitId = await this.getHighestReviewedCommitId({
      commenter,
      existingCommitIdsBlock,
      pullRequest: this.pullRequest
    })

    // PR ブランチの最後にレビューしたコミットと最新コミットの diff を取得する
    const incrementalDiff = await octokit.repos.compareCommits({
      owner: this.repo.owner,
      repo: this.repo.repo,
      base: highestReviewedCommitId,
      head: this.pullRequest.head.sha
    })

    // ターゲットブランチのベースコミットと PR ブランチの最新コミットの diff を取得する
    const targetBranchDiff = await octokit.repos.compareCommits({
      owner: this.repo.owner,
      repo: this.repo.repo,
      base: this.pullRequest.base.sha,
      head: this.pullRequest.head.sha
    })

    // PR ブランチの最後にレビューしたコミットと最新コミットの diff、つまりプッシュされた増分
    const incrementalFiles = incrementalDiff.data.files
    // ターゲットブランチのベースコミットと PR ブランチの最新コミットの diff、つまり PR ブランチの変更内容
    const targetBranchFiles = targetBranchDiff.data.files

    if (incrementalFiles == null || targetBranchFiles == null) {
      warning('Skipped: files data is missing')
      return
    }

    const files = targetBranchFiles.filter(targetBranchFile =>
      incrementalFiles.some(
        incrementalFile =>
          incrementalFile.filename === targetBranchFile.filename
      )
    )

    if (files.length === 0) {
      warning('Skipped: files is null')
      return
    }

    const {filterSelectedFiles} = this.filterSelectedFiles({files})

    if (filterSelectedFiles.length === 0) {
      warning('Skipped: filterSelectedFiles is null')
      return
    }

    const commits = incrementalDiff.data.commits

    if (commits.length === 0) {
      warning('Skipped: commits is null')
      return
    }
    // TODO: diffを取る、みたいな抽象概念にして別の関数に切り出した方がいい_end

    // レビューのため、hunksを取得する
    const filteredFiles: (TFilesAndChanges | null)[] = await Promise.all(
      filterSelectedFiles.map(file =>
        githubConcurrencyLimit(async () => {
          return this.retrieveFileContents({file})
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

    // hunk単位でレビューする
    let summarizeComment = ''
    const skippedFiles = []
    if (!this.options.disableReview) {
      const reviewPromises = []
      for (const [filename, , , patches] of filesAndChanges) {
        if (
          this.options.maxFiles <= 0 ||
          reviewPromises.length < this.options.maxFiles
        ) {
          reviewPromises.push(
            openaiConcurrencyLimit(async () => {
              await this.doReview({
                filename,
                patches,
                inputs,
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
        this.pullRequest.head.sha
      )}`

      // レビューを投稿する
      await commenter.submitReview(
        this.pullRequest.number,
        commits[commits.length - 1].sha
      )
    }

    // サマリーのコメントを投稿する
    await commenter.comment(`${summarizeComment}`, SUMMARIZE_TAG, 'replace')
  }

  private static validateContext(
    context: typeof githubContext
  ): context is IContextHasValidPullRequest {
    if (!VALID_EVENT_NAMES.includes(context.eventName)) {
      warning(
        `Skipped: current event is ${context.eventName}, only support pull_request event`
      )
      return false
    }

    if (context.payload.pull_request === undefined) {
      warning('Skipped: context.payload.pull_request is null')
      return false
    }

    const title = context.payload.pull_request.title
    if (INVALID_TITLE_KEYWORDS.some(keyword => title.includes(keyword))) {
      warning('Skipped: title contains invalid keywords')
      return false
    }

    return true
  }

  private getPreview = async ({
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
      return ''
    }

    const existingSummarizeCmtBody = existingSummarizeCmt.body
    const existingCommitIdsBlock = commenter.getReviewedCommitIdsBlock(
      existingSummarizeCmtBody
    )
    return existingCommitIdsBlock
  }

  /**
   * 最後にレビューしたコミットIDを取得する
   */
  private getHighestReviewedCommitId = async ({
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
      info(
        `Will review from the base commit: ${
          this.pullRequest.base.sha as string
        }`
      )
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
  private filterSelectedFiles = ({files}: {files: IFile[]}) => {
    // フィルタリングされたファイルをスキップする
    const filterSelectedFiles = []
    const filterIgnoredFiles = []
    for (const file of files) {
      if (!this.options.checkPath(file.filename)) {
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

  private retrieveFileContents = async ({file}: {file: IFile}) => {
    let fileContent = ''
    if (this.pullRequest == null) {
      warning('Skipped: context.payload.pull_request is null')
      return null
    }
    try {
      // ベースブランチのファイルコンテンツを取得する
      const contents = await octokit.repos.getContent({
        owner: this.repo.owner,
        repo: this.repo.repo,
        path: file.filename,
        ref: this.pullRequest.base.sha
      })
      if (contents.data != null) {
        if (!Array.isArray(contents.data)) {
          if (contents.data.type === 'file' && contents.data.content != null) {
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

    const patches: TPatch[] = []
    for (const patch of this.splitPatch(file.patch)) {
      const patchLines = this.patchStartEndLine(patch)
      if (patchLines == null) {
        continue
      }
      const hunks = this.parsePatch(patch)
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

  private patchStartEndLine = (
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

  private parsePatch = (
    patch: string
  ): {oldHunk: string; newHunk: string} | null => {
    const hunkInfo = this.patchStartEndLine(patch)
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

  private splitPatch = (patch: string | null | undefined): string[] => {
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

  private doReview = async ({
    filename,
    patches,
    inputs,
    commenter
  }: {
    filename: string
    patches: Array<TPatch>
    inputs: SimpleInputs
    commenter: Commenter
  }): Promise<void> => {
    info(`reviewing ${filename}`)
    const reviewsFailed: string[] = []

    // レビューを行う
    if (patches.length > 0) {
      for (const patch of patches) {
        try {
          await this.review({
            inputs,
            patch,
            commenter
          })
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
  }

  /**
   * パッチ単位でレビューを実行する
   */
  private review = async ({
    inputs,
    patch,
    commenter
  }: {
    inputs: SimpleInputs
    patch: TPatch
    commenter: Commenter
  }) => {
    const ins: SimpleInputs = inputs.clone()
    ins.patch = patch[PATCH.CONTENT]

    const isNeedToReview = await this.checkIsNeedToReview(ins)
    info(
      `filename: ${ins.filename}\n
       startLine:${patch[PATCH.START_LINE]}\n
       endLine"${PATCH.END_LINE}\n
       isNeedToReview: ${isNeedToReview}`
    )
    if (!isNeedToReview) {
      return
    }

    const reviewResult = await this.executeReview(ins, patch)
    info(`reviewResult: ${reviewResult}`)
    if (!reviewResult) {
      return
    }

    const isReviewValid = await this.checkReviewValidity(ins)
    info(`isReviewValid: ${isReviewValid}`)
    if (!isReviewValid) {
      return
    }

    await this.reflectReviewResultToCommenter(commenter, {
      fileName: ins.filename,
      startLine: reviewResult.startLine,
      endLine: reviewResult.endLine,
      comment: reviewResult.comment
    })
  }

  private checkIsNeedToReview = async (ins: SimpleInputs): Promise<boolean> => {
    try {
      const [checkResponse] = await this.lightBot.chat(
        this.prompts.renderTriagePatchDiff(ins),
        {}
      )
      return this.parseCheckIsNeedToReviewResponse(checkResponse)
    } catch (err: any) {
      warning(
        `Failed to check if needs review: ${err}, backtrace: ${err.stack}`
      )
      return false
    }
  }

  private parseCheckIsNeedToReviewResponse(response: string): boolean {
    if (!response) {
      return false
    }
    const triageRegex = /\[TRIAGE\]:\s*(NEEDS_REVIEW|APPROVED)/
    const triageMatch = response.match(triageRegex)

    if (!triageMatch) {
      return false
    }
    const triage = triageMatch[1]
    return triage === 'NEEDS_REVIEW'
  }

  private executeReview = async (
    ins: SimpleInputs,
    patch: TPatch
  ): Promise<Review | undefined> => {
    try {
      const [reviewResponse] = await this.heavyBot.chat(
        this.prompts.renderReviewPatchDiff(ins),
        {}
      )
      const reviews = this.parseReview(reviewResponse, [patch])
      return reviews[0]
    } catch (err: any) {
      warning(`Failed to review: ${err}, backtrace: ${err.stack}`)
      return undefined
    }
  }

  private checkReviewValidity = async (ins: SimpleInputs): Promise<boolean> => {
    try {
      const [checkResponse] = await this.lightBot.chat(
        this.prompts.renderCheckReviewValidity(ins),
        {}
      )
      return this.parseCheckReviewValidityResponse(checkResponse)
    } catch (err: any) {
      warning(
        `Failed to check review validity: ${err}, backtrace: ${err.stack}`
      )
      return false
    }
  }

  private parseCheckReviewValidityResponse(response: string): boolean {
    if (!response) {
      return false
    }
    const triageRegex = /\[TRIAGE\]:\s*(VALID|INVALID)/
    const triageMatch = response.match(triageRegex)

    if (!triageMatch) {
      return false
    }
    const triage = triageMatch[1]
    return triage === 'VALID'
  }

  private reflectReviewResultToCommenter = async (
    commenter: Commenter,
    {
      fileName,
      startLine,
      endLine,
      comment
    }: {
      fileName: string
      startLine: number
      endLine: number
      comment: string
    }
  ) => {
    try {
      await commenter.bufferReviewComment(
        fileName,
        startLine,
        endLine,
        `${comment}`
      )
    } catch (e: any) {
      warning(`Failed to reflect review result: ${e}, backtrace: ${e.stack}`)
    }
  }

  private parseReview(
    response: string,
    patches: TPatch[],
    debug = false
  ): Review[] {
    const reviews: Review[] = []

    response = this.sanitizeResponse(response.trim())

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

  private sanitizeResponse = (comment: string): string => {
    comment = this.sanitizeCodeBlock(comment, 'suggestion')
    comment = this.sanitizeCodeBlock(comment, 'diff')
    return comment
  }

  private sanitizeCodeBlock = (
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
}
