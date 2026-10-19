// 패널에서 펼친 주제의 순번 (0부터). 아무것도 안 펼쳤으면 null
export type OpenTopicIndex = number | null

declare module 'claude-code' {
  interface PluginState {
    'session-topics': {
      openTopicIndex: OpenTopicIndex
    }
  }
}
