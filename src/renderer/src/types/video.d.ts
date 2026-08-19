import 'react'

declare module 'react' {
  interface VideoHTMLAttributes<_T> {
    srcObject?: MediaStream | null
  }
}
