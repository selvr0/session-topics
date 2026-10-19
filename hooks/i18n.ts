// 패널·명령·Haiku 지시문에 쓰는 모든 글자. /config 의 session-topics.language 로 고름 (en | ko)

export type Language = 'en' | 'ko'

export type Messages = {
  pane: {
    close: string
    top: string
    bottom: string
    jump: string
    now: string
    empty: string
    noSummary: string
  }
  toast: {
    messageNotFound: (title: string) => string
    transcriptNotFound: string
    cannotMove: (reason: string) => string
  }
  command: { description: string; opened: string }
  // Haiku 에 넘기는 지시문과 대화 기록 머리말
  topics: {
    system: string
    user: string
  }
}

// Haiku 지시문 뼈대. 주제 이름·요약을 어떤 말로 쓸지만 언어마다 다름
const topicSystemOf = (writingRule: string) =>
  [
    'You split a conversation between a user and Claude into topics.',
    'A new topic starts where the user brings up something new. Continuing, fixing or checking the same thing stays in the same topic.',
    '',
    'Answer with a JSON array only, no other text. Each item:',
    '{ "start": number of the user message that opened the topic, "title": "...", "summary": "..." }',
    writingRule,
    'The last topic may still be going on. Then its summary is what has been done so far.',
  ].join('\n')

const en: Messages = {
  pane: {
    close: 'Close',
    top: 'Top',
    bottom: 'Bottom',
    jump: 'Jump',
    now: 'now ',
    empty: 'No topics yet. They appear after a reply finishes.',
    noSummary: 'No summary yet',
  },
  toast: {
    messageNotFound: title => `Could not find where "${title}" started`,
    transcriptNotFound: 'Transcript file not found yet. Send a message, then try again',
    cannotMove: reason => `Could not move: ${reason}`,
  },
  command: { description: 'Open the Session Topics pane', opened: 'Opened the Session Topics pane.' },
  topics: {
    system: topicSystemOf('Write in English. title: a short noun phrase. summary: one line on what was decided.'),
    user: 'User',
  },
}

const ko: Messages = {
  pane: {
    close: '닫기',
    top: '맨 위',
    bottom: '맨 끝',
    jump: '이동',
    now: '지금 ',
    empty: '아직 주제 없음. 답이 하나 끝나면 생김.',
    noSummary: '요약 아직 없음',
  },
  toast: {
    messageNotFound: title => `"${title}" 시작 메시지를 못 찾음`,
    transcriptNotFound: '대화 기록 파일을 아직 못 찾음. 메시지를 하나 보낸 뒤 다시 누름',
    cannotMove: reason => `이동 못 함: ${reason}`,
  },
  command: { description: 'Session Topics 패널을 엶', opened: 'Session Topics 패널을 열었음.' },
  topics: {
    system: topicSystemOf(
      'Write in Korean. title: 짧은 명사구. summary: 무엇을 정했는지 한 줄, 음슴체(~함, ~임)로 끝냄.',
    ),
    user: '사용자',
  },
}

export const MESSAGES: Record<Language, Messages> = { en, ko }

// /config 값이 없거나 모르는 값이면 영어
export function resolveMessages(language: unknown): Messages {
  return language === 'ko' ? ko : en
}
