import type {
  ClawImChannelV1,
  ClawImDingTalkPlatformCredentialV1,
  ClawImQqPlatformCredentialV1,
  ClawImWeComPlatformCredentialV1
} from '../shared/app-settings'

export type RegionalInboundMessage = {
  provider: 'qq' | 'dingtalk' | 'wecom'
  chatId: string
  messageId: string
  senderId: string
  senderName: string
  text: string
  reply: (text: string) => Promise<void>
}

export type RegionalChannelBridge = {
  start: () => Promise<void>
  stop: () => Promise<void>
}

type RegionalChannel = ClawImChannelV1 & {
  platformCredential:
    | ClawImQqPlatformCredentialV1
    | ClawImDingTalkPlatformCredentialV1
    | ClawImWeComPlatformCredentialV1
}

type RegionalBridgeOptions = {
  channel: RegionalChannel
  onMessage: (message: RegionalInboundMessage) => Promise<void>
  onError: (message: string, context?: Record<string, unknown>) => void
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const REGIONAL_CHANNEL_MARKDOWN_DEFAULTS = {
  qq: true,
  dingtalk: true,
  wecom: true
} as const

type QqReplyPayload = {
  msg_type: 0 | 2
  msg_id: string
  msg_seq: number
  content?: string
  markdown?: {
    content?: string
    custom_template_id?: string
    params?: Array<{ key: string; values: string[] }>
  }
}

export function createQqMarkdownReplyPayload(
  text: string,
  messageId: string,
  credential: Pick<ClawImQqPlatformCredentialV1, 'markdownTemplateId' | 'markdownTemplateKey'>,
  msgSeq: number
): QqReplyPayload {
  const templateId = credential.markdownTemplateId?.trim()
  const markdown = templateId
    ? {
        custom_template_id: templateId,
        params: [{
          key: credential.markdownTemplateKey?.trim() || 'content',
          values: [text]
        }]
      }
    : { content: text }
  return {
    markdown,
    msg_type: 2,
    msg_id: messageId,
    msg_seq: msgSeq
  }
}

export function formatQqPlainTextFallback(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1：$2')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^\s*[-*_]{3,}\s*$/gm, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/`{1,3}([^`]+)`{1,3}/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function createQqPlainTextReplyPayload(
  text: string,
  messageId: string,
  msgSeq: number
): QqReplyPayload {
  return {
    content: formatQqPlainTextFallback(text),
    msg_type: 0,
    msg_id: messageId,
    msg_seq: msgSeq
  }
}

export async function replyQqMarkdownWithFallback(
  sendMarkdown: () => Promise<unknown>,
  sendPlainText: () => Promise<unknown>,
  onFallback: (error: unknown) => void
): Promise<void> {
  try {
    await sendMarkdown()
  } catch (error) {
    onFallback(error)
    await sendPlainText()
  }
}

function createQqBridge(options: RegionalBridgeOptions): RegionalChannelBridge {
  const credential = options.channel.platformCredential as ClawImQqPlatformCredentialV1
  let bot: { start: () => Promise<unknown>; stop: () => Promise<void> } | null = null
  return {
    async start() {
      const { Bot, ReceiverMode } = await import('qq-official-bot')
      const instance = new Bot({
        appid: credential.appId,
        secret: credential.appSecret,
        sandbox: false,
        removeAt: true,
        logLevel: 'warn',
        maxRetry: 10,
        intents: ['GROUP_AND_C2C_EVENT'],
        mode: ReceiverMode.WEBSOCKET
      })
      instance.on('message', (event) => {
        if (!('raw_message' in event) || typeof event.reply !== 'function') return
        const text = event.raw_message.trim()
        if (!text) return
        void options.onMessage({
          provider: 'qq',
          chatId: event.group_id || event.user_id,
          messageId: event.message_id,
          senderId: event.user_id,
          senderName: event.sender?.user_name || event.user_id,
          text,
          reply: async (replyText) => {
            const endpoint = event.group_id
              ? `/v2/groups/${encodeURIComponent(event.group_id)}/messages`
              : `/v2/users/${encodeURIComponent(event.user_id)}/messages`
            await replyQqMarkdownWithFallback(
              () => instance.request.post(
                endpoint,
                createQqMarkdownReplyPayload(
                  replyText,
                  event.message_id,
                  credential,
                  Math.floor(Math.random() * 65_536)
                )
              ),
              () => instance.request.post(
                endpoint,
                createQqPlainTextReplyPayload(
                  replyText,
                  event.message_id,
                  Math.floor(Math.random() * 65_536)
                )
              ),
              (error) => {
                options.onError('QQ Markdown reply was rejected; falling back to plain text.', {
                  error: errorText(error)
                })
              }
            )
          }
        }).catch((error) => {
          options.onError('QQ inbound message failed.', { error: errorText(error) })
        })
      })
      bot = instance
      await instance.start()
    },
    async stop() {
      const current = bot
      bot = null
      if (current) await current.stop()
    }
  }
}

function createDingTalkBridge(options: RegionalBridgeOptions): RegionalChannelBridge {
  const credential = options.channel.platformCredential as ClawImDingTalkPlatformCredentialV1
  let client: { disconnect: () => void } | null = null
  return {
    async start() {
      const { DWClient, EventAck, TOPIC_ROBOT } = await import('dingtalk-stream')
      const instance = new DWClient({
        clientId: credential.clientId,
        clientSecret: credential.clientSecret,
        keepAlive: true
      })
      instance.registerCallbackListener(TOPIC_ROBOT, (downstream) => {
        instance.socketCallBackResponse(downstream.headers.messageId, {
          status: EventAck.SUCCESS
        })
        try {
          const payload = JSON.parse(downstream.data) as {
            conversationId?: string
            msgId?: string
            senderId?: string
            senderStaffId?: string
            senderNick?: string
            sessionWebhook?: string
            text?: { content?: string }
          }
          const text = payload.text?.content?.trim() ?? ''
          const sessionWebhook = payload.sessionWebhook?.trim() ?? ''
          if (!text || !sessionWebhook) return
          void options.onMessage({
            provider: 'dingtalk',
            chatId: payload.conversationId?.trim() || payload.senderId?.trim() || 'dingtalk',
            messageId: payload.msgId?.trim() || downstream.headers.messageId,
            senderId: payload.senderStaffId?.trim() || payload.senderId?.trim() || '',
            senderName: payload.senderNick?.trim() || payload.senderStaffId?.trim() || 'DingTalk user',
            text,
            reply: async (replyText) => {
              const response = await fetch(sessionWebhook, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  msgtype: 'markdown',
                  markdown: { title: 'legalwork', text: replyText }
                })
              })
              if (!response.ok) throw new Error(`DingTalk reply failed: HTTP ${response.status}`)
            }
          }).catch((error) => {
            options.onError('DingTalk inbound message failed.', { error: errorText(error) })
          })
        } catch (error) {
          options.onError('DingTalk payload parsing failed.', { error: errorText(error) })
        }
      })
      client = instance
      await instance.connect()
    },
    async stop() {
      const current = client
      client = null
      current?.disconnect()
    }
  }
}

function createWeComBridge(options: RegionalBridgeOptions): RegionalChannelBridge {
  const credential = options.channel.platformCredential as ClawImWeComPlatformCredentialV1
  let client: { disconnect: () => void } | null = null
  return {
    async start() {
      const { WSClient, generateReqId } = await import('@wecom/aibot-node-sdk')
      const instance = new WSClient({
        botId: credential.botId,
        secret: credential.secret,
        maxReconnectAttempts: -1
      })
      instance.on('message.text', (frame) => {
        const body = frame.body
        const text = body?.text?.content?.trim() ?? ''
        if (!body || !text) return
        void options.onMessage({
          provider: 'wecom',
          chatId: body.chatid?.trim() || body.from?.userid?.trim() || 'wecom',
          messageId: body.msgid?.trim() || frame.headers.req_id,
          senderId: body.from?.userid?.trim() || '',
          senderName: body.from?.userid?.trim() || 'WeCom user',
          text,
          reply: async (replyText) => {
            await instance.replyStream(frame, generateReqId('legalwork'), replyText, true)
          }
        }).catch((error) => {
          options.onError('WeCom inbound message failed.', { error: errorText(error) })
        })
      })
      instance.on('error', (error) => {
        options.onError('WeCom connection error.', { error: errorText(error) })
      })
      client = instance
      instance.connect()
    },
    async stop() {
      const current = client
      client = null
      current?.disconnect()
    }
  }
}

export function isRegionalChannel(
  channel: ClawImChannelV1
): channel is RegionalChannel {
  return (
    (channel.provider === 'qq' && channel.platformCredential?.kind === 'qq') ||
    (channel.provider === 'dingtalk' && channel.platformCredential?.kind === 'dingtalk') ||
    (channel.provider === 'wecom' && channel.platformCredential?.kind === 'wecom')
  )
}

export function regionalChannelKey(channel: RegionalChannel): string {
  const credential = channel.platformCredential
  if (credential.kind === 'qq') {
    return [
      'qq',
      credential.appId,
      credential.appSecret,
      credential.markdownTemplateId ?? '',
      credential.markdownTemplateKey ?? ''
    ].join(':')
  }
  if (credential.kind === 'dingtalk') {
    return `dingtalk:${credential.clientId}:${credential.clientSecret}`
  }
  return `wecom:${credential.botId}:${credential.secret}`
}

export function createRegionalChannelBridge(
  options: RegionalBridgeOptions
): RegionalChannelBridge {
  if (options.channel.provider === 'qq') return createQqBridge(options)
  if (options.channel.provider === 'dingtalk') return createDingTalkBridge(options)
  return createWeComBridge(options)
}
