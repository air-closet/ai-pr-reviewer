export class SimpleInputs {
  systemMessage: string
  title: string
  filename: string
  patch: string
  review: string

  constructor(
    systemMessage = '',
    title = 'no title provided',
    filename = '',
    patch = '',
    review = ''
  ) {
    this.systemMessage = systemMessage
    this.title = title
    this.filename = filename
    this.patch = patch
    this.review = review
  }

  clone(): SimpleInputs {
    return new SimpleInputs(
      this.systemMessage,
      this.title,
      this.filename,
      this.patch,
      this.review
    )
  }

  render(content: string): string {
    if (!content) {
      return ''
    }
    if (this.systemMessage) {
      content = content.replace('$system_message', this.systemMessage)
    }
    if (this.title) {
      content = content.replace('$title', this.title)
    }
    if (this.filename) {
      content = content.replace('$filename', this.filename)
    }
    if (this.patch) {
      content = content.replace('$patch', this.patch)
    }
    if (this.review) {
      content = content.replace('$review', this.review)
    }
    return content
  }
}
