import * as pb from './hackerterm'

export interface ProtocolError {
  code: number
  key: string
  params: Record<string, string>
  detail: string
  retryable: boolean
}

interface Transport {
  send(bytes: Uint8Array): void
}

export class ProtocolClient {
  private nextId = 1
  private pending = new Map<string, { resolve: (b: Uint8Array) => void; reject: (e: ProtocolError) => void }>()
  private subscribers = new Map<string, Array<(payload: Uint8Array) => void>>()

  constructor(private transport: Transport) {}

  request(method: string, payload: Uint8Array): Promise<Uint8Array> {
    const id = this.nextId++
    const bytes = pb.Envelope.encode({ request: { id, method, payload } }).finish()
    return new Promise((resolve, reject) => {
      this.pending.set(id.toString(), { resolve, reject })
      this.transport.send(bytes)
    })
  }

  on(topic: string, fn: (payload: Uint8Array) => void): void {
    const list = this.subscribers.get(topic) ?? []
    list.push(fn)
    this.subscribers.set(topic, list)
  }

  handleInbound(bytes: Uint8Array): void {
    const env = pb.Envelope.decode(bytes)

    if (env.response) {
      const key = env.response.id.toString()
      const waiter = this.pending.get(key)
      if (!waiter) return // 迟到的响应，丢弃
      this.pending.delete(key)
      if (env.response.error) waiter.reject(env.response.error as ProtocolError)
      else waiter.resolve(env.response.payload ?? new Uint8Array())
      return
    }

    if (env.event) {
      // 未知 topic 静默丢弃，见协议 §7.4
      for (const fn of this.subscribers.get(env.event.topic) ?? []) {
        fn(env.event.payload ?? new Uint8Array())
      }
    }
  }
}
