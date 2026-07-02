/// <reference types="vite/client" />

declare namespace JSX {
  interface IntrinsicElements {
    webview: React.DetailedHTMLProps<
      React.HTMLAttributes<Electron.WebviewTag> & {
        src?: string
        partition?: string
        allowpopups?: boolean | string
        plugins?: boolean | string
        useragent?: string
        webpreferences?: string
      },
      Electron.WebviewTag
    >
  }
}
