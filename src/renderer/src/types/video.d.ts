import 'react'

declare module 'react' {
  interface VideoHTMLAttributes<T> {
    srcObject?: MediaStream | null
  }
}
