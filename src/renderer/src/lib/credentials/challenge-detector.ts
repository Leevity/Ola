// Re-export the shared detector so the renderer code can import from
// `@renderer/lib/credentials/challenge-detector` as planned in P2 §2.1.
export {
  detectChallenge,
  detectUnknownChallenge,
  snapshotFromHtml,
  type PageSnapshot
} from '../../../../shared/challenge-detector-shared'
