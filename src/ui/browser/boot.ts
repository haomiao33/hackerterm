import { ProtocolClient } from '../common/protocol/client'
import { Hello } from '../common/protocol/hackerterm'

const log = (s: string) => { document.getElementById('log')!.textContent += `\n${s}` }

window.addEventListener('message', (e) => {
  if (e.data?.kind !== 'port:control') return
  const port = e.ports[0]
  const client = new ProtocolClient({ send: (b) => port.postMessage(b) })
  port.onmessage = (m) => client.handleInbound(new Uint8Array(m.data))
  port.start()

  const payload = Hello.encode({
    protocolMajor: 1, protocolMinor: 0, minSupportedMajor: 1,
    implVersion: 'shell-m0', capabilities: [],
  }).finish()

  client.request('hello', payload)
    .then((p) => log(`core capabilities: ${Hello.decode(p).capabilities.join(', ')}`))
    .catch((err) => log(`handshake failed: ${err.key}`))
})
