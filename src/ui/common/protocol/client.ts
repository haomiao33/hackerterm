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
  private nextId = 1n
  private pending = new Map<string, { resolve: (b: Uint8Array) => void; reject: (e: ProtocolError) => void }>()
  private subscribers = new Map<string, Array<(payload: Uint8Array) => void>>()

  constructor(private transport: Transport) {}

  request(method: string, payload: Uint8Array): Promise<Uint8Array> {
    throw new globalThis.Error('not implemented')
  }

  on(topic: string, fn: (payload: Uint8Array) => void): void {
    throw new globalThis.Error('not implemented')
  }

  handleInbound(bytes: Uint8Array): void {
    throw new globalThis.Error('not implemented')
  }
}
