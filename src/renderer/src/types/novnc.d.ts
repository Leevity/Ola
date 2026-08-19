declare module '@novnc/novnc' {
  export default class RFB extends EventTarget {
    constructor(
      target: HTMLElement,
      url: string,
      options?: {
        shared?: boolean
      }
    )
    sendCredentials(credentials: { username?: string; password?: string }): void
    sendKey(keysym: number, code: string, down: boolean): void
    getImageData(): ImageData
    scaleViewport: boolean
    resizeSession: boolean
    viewOnly: boolean
    background: string
    /** 0-9, controls JPEG quality for Tight encoding (higher = better, more bandwidth). */
    qualityLevel: number
    /** 0-9, controls compression level for Tight encoding (higher = more compressed). */
    compressionLevel: number
    focus(): void
    disconnect(): void
  }
}
