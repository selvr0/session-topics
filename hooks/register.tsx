import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { OpenTopicIndex } from '../types'
import { type Messages, MESSAGES, resolveMessages } from './i18n'

const PANE = 'session-topics'
const PANE_TITLE = 'Session Topics'

// 주제를 나누는 모델. Claude Code 세션의 연결로 부름
const TOPIC_MODEL = 'haiku'

// 주제 하나:
// title:       "저장 방식: md → 세션별 저장소"
// summary:     "세션 ID 키로 $.store 에 JSON 저장. 도구로만 고침"
// anchorText:  "세션마다 따로 저장해야하는데, 이거 md로..."   ← 주제를 연 사용자 메시지 앞부분
// messageId:   "8f3c...-..."                                 ← 그 메시지 줄의 ID. 모르면 없음
type SessionTopic = {
  title: string
  summary: string
  anchorText: string
  messageId?: string
}

// 대화 기록 한 줄:
// role:        "user" 사용자 메시지 / "assistant" Claude 답
// text:        본문 앞부분 (ENTRY_LENGTH 까지)
// anchorText:  user 만. 메시지 줄을 찾을 때 쓰는 앞부분
type ConversationEntry = {
  role: 'user' | 'assistant'
  text: string
  anchorText?: string
}

// $.store 에 세션마다:
// key "topics:<세션 ID>"     → SessionTopic[]  패널이 그리는 주제 전체
// key "transcript:<세션 ID>" → 이 세션 대화 기록 파일(.jsonl) 경로
const transcriptKeyOf = (sessionId: string) => `transcript:${sessionId}`
const topicsKeyOf = (sessionId: string) => `topics:${sessionId}`

// haiku 에 넘길 대화 줄 수 상한. 긴 세션은 최근 것만 넘김
const MAX_ENTRIES = 400

// 패널에서 펼친 주제. 다시 불려와도 남도록 $.state 에 둠
const openTopicIndexAtom = atom({ plugin: 'session-topics', key: 'openTopicIndex' } as const, null as OpenTopicIndex)

const ANCHOR_LENGTH = 200
const ENTRY_LENGTH = 600
const anchorOf = (text: string) => text.trim().slice(0, ANCHOR_LENGTH)

// 화면에 그려진 사용자 메시지:
// key:   메시지 앞부분 (anchorOf)
// value: 그 메시지 줄의 requestId (메시지 ID). $.ui.scroll 이 이 값으로 이동함
// 다시 불려오면 비고, 줄이 다시 그려질 때 채워짐
const promptMessageIds = new Map<string, string>()

// 앵커와 맞는 메시지 ID 를 찾음. 같은 앞부분이거나, 한쪽이 다른 쪽의 앞부분이면 맞음
const findPromptMessageId = (anchorText: string) => {
  const exact = promptMessageIds.get(anchorText)
  if (exact) return exact
  for (const [text, id] of promptMessageIds) {
    if (text.startsWith(anchorText) || anchorText.startsWith(text)) return id
  }

  return undefined
}

// 대화 기록 파일에서 앵커로 시작하는 사용자 메시지를 찾아 그 uuid 를 돌려줌.
// 메시지 줄의 requestId 가 이 uuid 와 같음. 화면에 안 그려진 옛 메시지도 찾을 수 있음
//
// 기록 파일 한 줄 (사용자 메시지):
// {"type":"user","message":{"role":"user","content":"좋아. 그렇게 하자."},"uuid":"0a0b...", ...}
const findMessageIdInTranscript = async ($: EngineInterface, anchorText: string) => {
  const transcriptPath = (await $.store.get(transcriptKeyOf(await $.session.id()))) as string | undefined
  if (!transcriptPath) return undefined

  // 기록 파일은 JSON 으로 이스케이프돼 있음. 줄바꿈·따옴표·역슬래시 앞까지만 grep 함
  const prefix = (anchorText.split(/[\n"\\]/)[0] ?? '').slice(0, 40)
  if (prefix.trim() === '') return undefined
  const found = await $.process
    .run(['grep', '-F', '-m', '20', `"role":"user","content":"${prefix}`, transcriptPath])
    .catch(() => undefined)
  if (!found || found.exitCode !== 0) return undefined

  for (const line of found.stdout.split('\n')) {
    try {
      const row = JSON.parse(line) as { type?: string; uuid?: string; message?: { content?: unknown } }
      const content = row.message?.content
      if (row.type === 'user' && typeof content === 'string' && anchorOf(content).startsWith(prefix) && row.uuid) {
        return row.uuid
      }
    } catch {
      // 줄이 잘렸거나 JSON 이 아니면 건너뜀
    }
  }

  return undefined
}

// 화면에서 본 메시지 ID 가 있으면 그걸, 없으면 기록 파일에서 찾음
const resolveTopicMessageId = async ($: EngineInterface, anchorText: string) =>
  findPromptMessageId(anchorText) ?? (await findMessageIdInTranscript($, anchorText))

type TranscriptRow = { type?: string; uuid?: string; isMeta?: boolean; message?: { content?: unknown } }

// 기록 파일 한 줄이 화면에 메시지 줄로 그려지는 행인지:
// 사용자가 친 메시지(content 가 글자) 또는 글이 있는 Claude 답 (도구 호출만 있는 행은 도구 줄로 그려져서 뺌)
const isDrawnMessageRow = (row: TranscriptRow) => {
  if (row.isMeta || !row.uuid) return false
  const content = row.message?.content
  if (row.type === 'user') return typeof content === 'string'
  if (row.type === 'assistant') {
    return Array.isArray(content) && content.some(block => (block as { type?: string })?.type === 'text')
  }

  return false
}

// 기록 파일의 첫 메시지 또는 마지막 메시지 uuid. 맨 위·맨 끝 버튼이 씀
const findEdgeMessageIdInTranscript = async ($: EngineInterface, edge: 'first' | 'last') => {
  const transcriptPath = (await $.store.get(transcriptKeyOf(await $.session.id()))) as string | undefined
  if (!transcriptPath) return undefined

  // 첫 메시지는 사용자 메시지라 grep 으로, 마지막은 파일 끝 몇백 줄에서 찾음
  const argv =
    edge === 'first'
      ? ['grep', '-F', '-m', '20', '"type":"user"', transcriptPath]
      : ['tail', '-n', '300', transcriptPath]
  const found = await $.process.run(argv).catch(() => undefined)
  if (!found || found.exitCode !== 0) return undefined

  const rows: TranscriptRow[] = []
  for (const line of found.stdout.split('\n')) {
    try {
      rows.push(JSON.parse(line) as TranscriptRow)
    } catch {
      // 잘린 줄은 건너뜀
    }
  }
  const drawn = rows.filter(isDrawnMessageRow)

  return (edge === 'first' ? drawn[0] : drawn[drawn.length - 1])?.uuid
}

// 지금 언어의 글자. register 에서 /config 값으로 정함
let text: Messages = MESSAGES.en

// 세션 대화 전체를 ConversationEntry 로 바꿈. 사용자가 직접 친 메시지와 글이 있는 Claude 답만 남김
// (도구 결과, 명령 출력·시스템 알림처럼 '<' 로 시작하는 줄은 뺌)
const readConversationEntries = async ($: EngineInterface): Promise<ConversationEntry[]> => {
  const messages = await $.session.messages()
  if ('deny' in messages) return []

  const entries: ConversationEntry[] = []
  for (const message of messages) {
    const body = message.text.trim()
    if (body === '' || body.startsWith('<')) continue
    if (message.role === 'user') {
      if (message.toolResults?.length) continue
      entries.push({ role: 'user', text: body.slice(0, ENTRY_LENGTH), anchorText: anchorOf(body) })
    } else {
      entries.push({ role: 'assistant', text: body.slice(0, ENTRY_LENGTH) })
    }
  }

  return entries.slice(-MAX_ENTRIES)
}

// 대화 기록을 모델에 넘길 글로 만듦. 사용자 메시지에만 번호를 붙임 (1부터)
const formatConversationForTopics = (log: ConversationEntry[]) => {
  const lines: string[] = []
  let userNumber = 0
  for (const entry of log) {
    if (entry.role === 'user') {
      userNumber += 1
      lines.push(`[${userNumber}] ${text.topics.user}: ${entry.text}`)
    } else {
      lines.push(`    Claude: ${entry.text}`)
    }
  }

  return lines.join('\n')
}

type GeneratedTopic = { start: number; title: string; summary: string }

// 모델 답에서 JSON 배열을 꺼내 확인함. 틀리면 undefined
const parseGeneratedTopics = (text: string): GeneratedTopic[] | undefined => {
  const json = text.slice(text.indexOf('['), text.lastIndexOf(']') + 1)
  try {
    const raw = JSON.parse(json) as unknown
    if (!Array.isArray(raw)) return undefined
    const topics = raw.filter(
      (item): item is GeneratedTopic =>
        typeof item?.start === 'number' && typeof item?.title === 'string' && typeof item?.summary === 'string',
    )

    return topics.length > 0 ? topics : undefined
  } catch {
    return undefined
  }
}

// 지금 주제를 만드는 중인지. 겹쳐 부르면 뒤의 것은 건너뜀
let isRegenerating = false

// 세션 대화 전체를 haiku 로 나눠서 topics 를 새로 씀
const regenerateSessionTopics = async ($: EngineInterface) => {
  if (isRegenerating) return
  isRegenerating = true
  try {
    const log = await readConversationEntries($)
    const userEntries = log.filter(entry => entry.role === 'user')
    if (userEntries.length === 0) return

    const reply = await $.model.complete({
      model: TOPIC_MODEL,
      system: text.topics.system,
      prompt: formatConversationForTopics(log),
      maxTokens: 2000,
    })
    if (!reply.isAnswered) return
    const generated = parseGeneratedTopics(reply.text)
    if (!generated) return

    const topics: SessionTopic[] = []
    for (const topic of generated) {
      const anchorText = userEntries[topic.start - 1]?.anchorText
      if (!anchorText) continue
      topics.push({
        title: topic.title,
        summary: topic.summary,
        anchorText,
        messageId: await resolveTopicMessageId($, anchorText),
      })
    }

    await $.store.set(topicsKeyOf(await $.session.id()), topics)
    $.ui.invalidate('ui.render')
  } finally {
    isRegenerating = false
  }
}

// 이 hook 이 끝난 뒤 따로 돌림. haiku 답을 기다리느라 입력이 막히지 않게
const scheduleTopicRegeneration = ($: EngineInterface) =>
  $.clock.after(0, () => void regenerateSessionTopics($).catch(() => undefined))

export const register: Register = (on, options) => {
  text = resolveMessages(options.language)

  on('session.start', async ($, e, next) => {
    // 이미 열린 패널은 처음 열 때 받은 제목을 그대로 씀. 다시 불려올 때 지금 제목으로 바꿔 줌
    const isPaneOpen = (await $.ui.panes()).some(pane => pane.id === PANE)
    if (isPaneOpen) void $.ui.open({ id: PANE, title: PANE_TITLE })

    await $.command.register({ name: 'session-topics', description: text.command.description })

    return next(e)
  })

  // 패널을 열 때 주제가 아직 없으면 지금까지의 대화로 바로 만듦
  on('command.run', { command: 'session-topics' }, async $ => {
    await $.ui.open({ id: PANE, title: PANE_TITLE })
    const topics = (await $.store.get(topicsKeyOf(await $.session.id()))) as SessionTopic[] | undefined
    if (!topics?.length) scheduleTopicRegeneration($)

    return { text: text.command.opened }
  })

  // 대화 기록 파일 경로를 남김. 옛 메시지의 ID 를 찾을 때 씀
  on('classic.UserPromptSubmit', async ($, e, next) => {
    if (e.transcript_path) await $.store.set(transcriptKeyOf(await $.session.id()), e.transcript_path)

    return next(e)
  })

  // Claude 답이 끝나면 주제를 다시 나눔
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined && e.answer.trim() !== '') scheduleTopicRegeneration($)

    return next(e)
  })

  // 사용자 메시지 줄이 그려질 때 그 줄의 메시지 ID 를 기억함. 그리는 건 엔진에 맡김
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    if (e.props.origin.kind === 'composer' && e.props.text.trim() !== '') {
      promptMessageIds.set(anchorOf(e.props.text), e.requestId)
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const topics = ((await $.store.get(topicsKeyOf(await $.session.id()))) as SessionTopic[] | undefined) ?? []
    const openTopicIndex = await read($, openTopicIndexAtom)
    const width = e.props.bodyColumns

    const toggleTopicOpen = (index: number) => update($, openTopicIndexAtom, open => (open === index ? null : index))

    const jumpToTopicStart = async (topic: SessionTopic) => {
      const messageId = topic.messageId ?? (await resolveTopicMessageId($, topic.anchorText))
      if (!messageId) {
        $.ui.toast(text.toast.messageNotFound(topic.title))
        return
      }
      const moved = await $.ui.scroll({ to: { requestId: messageId }, block: 'start' })
      const deny = 'deny' in moved ? moved.deny : undefined
      if (deny) $.ui.toast(text.toast.cannotMove(deny))
    }

    // 대화 맨 위(첫 메시지) / 맨 끝(마지막 메시지)으로 이동
    const jumpToConversationEdge = async (edge: 'first' | 'last') => {
      const messageId = await findEdgeMessageIdInTranscript($, edge)
      if (!messageId) {
        $.ui.toast(text.toast.transcriptNotFound)
        return
      }
      const moved = await $.ui.scroll({ to: { requestId: messageId }, block: edge === 'first' ? 'start' : 'end' })
      const deny = 'deny' in moved ? moved.deny : undefined
      if (deny) $.ui.toast(text.toast.cannotMove(deny))
    }

    // 제목을 누르면 그 줄 아래에 펼쳐지는 부분. 요약은 테두리 상자로 제목과 떼어 놓음:
    //   ╭──────────────────────╮
    //   │ <요약>               │
    //   ╰──────────────────────╯
    //   [ 이동 ]
    const renderTopicDetail = (topic: SessionTopic, index: number) => (
      <Box key={`detail-${index}`} flexDirection="column" paddingLeft={3} marginBottom={1}>
        <Box borderStyle="round" borderDimColor paddingX={1}>
          {topic.summary ? <Text>{topic.summary}</Text> : <Text dimColor>{text.pane.noSummary}</Text>}
        </Box>
        <Box>
          <Button key={`jump-${index}`} variant="primary" label={text.pane.jump} onPress={() => jumpToTopicStart(topic)} />
        </Box>
      </Box>
    )

    return (
      <Box flexDirection="column">
        {/* 헤더: 패널 이름 + 닫기 */}
        <Box>
          <Text bold>{PANE_TITLE}</Text>
          <Box flexGrow={1} />
          <Button key="close-pane" role="dismiss" label={text.pane.close} onPress={() => $.ui.close({ id: PANE })} />
        </Box>
        {/* 대화 이동: 맨 위·맨 끝 */}
        <Box columnGap={1}>
          <Button key="jump-first" label={text.pane.top} onPress={() => jumpToConversationEdge('first')} />
          <Button key="jump-last" label={text.pane.bottom} onPress={() => jumpToConversationEdge('last')} />
        </Box>
        <Text dimColor>{'─'.repeat(Math.max(1, width))}</Text>
        {topics.length === 0 && <Text dimColor>{text.pane.empty}</Text>}
        {topics.map((topic, index) => {
          const isOpen = openTopicIndex === index
          const isCurrent = index === topics.length - 1

          return (
            <Box key={`topic-${index}`} flexDirection="column">
              <Box>
                <Button key={`fold-${index}`} plain onPress={() => toggleTopicOpen(index)}>
                  <Text bold={isCurrent} color={isCurrent ? 'yellow' : undefined}>
                    {isOpen ? '▾' : '▸'} {index + 1}. {topic.title}
                  </Text>
                </Button>
                <Box flexGrow={1} />
                {isCurrent && <Text dimColor>{text.pane.now}</Text>}
              </Box>
              {isOpen && renderTopicDetail(topic, index)}
            </Box>
          )
        })}
      </Box>
    )
  })
}
