// @vitest-environment node
/**
 * @see https://github.com/mswjs/interceptors/issues/862
 */
import net from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import { FetchInterceptor } from '#/src/interceptors/fetch/node'
import { createRawTestServer, getClosedPort } from '#/test/helpers'

const interceptor = new FetchInterceptor()

beforeAll(() => {
  interceptor.apply()
})

afterEach(() => {
  interceptor.removeAllListeners()
})

afterAll(() => {
  interceptor.dispose()
})

it('intercepts a request whose body arrives after the client starts reading a new connection', async () => {
  const requestListener = vi.fn<(body: string) => void>()
  interceptor.on('request', async ({ request, controller }) => {
    requestListener(await request.text())
    controller.respondWith(new Response('mocked'))
  })

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      await sleep(20)
      controller.enqueue(new TextEncoder().encode('hello'))
      controller.close()
    },
  })

  const response = await fetch(
    `http://127.0.0.1:${await getClosedPort()}/resource`,
    {
      method: 'POST',
      body,
      // @ts-expect-error Undocumented Node.js property.
      duplex: 'half',
    }
  )

  await expect(response.text()).resolves.toBe('mocked')
  expect(requestListener).toHaveBeenCalledExactlyOnceWith('hello')
})

it('intercepts a request sent after aborted requests to the same origin', async () => {
  const startedRequests = vi.fn()
  interceptor.on('request', async ({ request, controller }) => {
    startedRequests()
    // A mocked response that is not instant, like a real one.
    await sleep(request.url.includes('/slow/') ? 200 : 20)
    controller.respondWith(Response.json({ ok: true }))
  })

  /**
   * @note Undici opens a new connection for each aborted request and
   * writes nothing to it. A request sent a few event loop turns later
   * may then be written to one of those connections. Each round uses
   * a new origin, so a new connection pool.
   */
  for (let turns = 0; turns < 6; turns++) {
    const origin = `http://localhost:${await getClosedPort()}`
    const abortController = new AbortController()
    startedRequests.mockClear()

    for (const n of [1, 2]) {
      fetch(`${origin}/slow/${n}`, { signal: abortController.signal }).catch(
        () => undefined
      )
    }

    await expect.poll(() => startedRequests).toHaveBeenCalledTimes(2)
    abortController.abort()

    for (let turn = 0; turn < turns; turn++) {
      await new Promise((resolve) => setImmediate(resolve))
    }

    const response = await fetch(`${origin}/ping`, { method: 'POST' })
    await expect(response.json()).resolves.toEqual({ ok: true })
  }
})

it('passes a server-first connection that a request listener opens through', async () => {
  await using server = await createRawTestServer(() => {
    return new net.Server((connection) => {
      connection.write('220 HELLO')
    })
  })

  interceptor.on('request', async ({ controller }) => {
    // A client that waits for the server to speak first (e.g. SMTP).
    const greeting = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(server.port, server.hostname)
      socket.on('data', (chunk) => {
        resolve(chunk.toString())
        socket.destroy()
      })
      socket.on('error', reject)
    })

    controller.respondWith(new Response(greeting))
  })

  const response = await fetch(
    `http://127.0.0.1:${await getClosedPort()}/resource`
  )

  await expect(response.text()).resolves.toBe('220 HELLO')
})

it('passes a connection to a host the URL parser rejects through', async () => {
  interceptor.on('request', async ({ controller }) => {
    const error = await new Promise<Error>((resolve) => {
      const socket = net.connect({
        host: 'a b',
        port: 80,
        // Fail the lookup of this host without a real one.
        lookup: (_hostname, _options, callback) => {
          callback(new Error('lookup failed'), '', 0)
        },
      })
      socket.on('data', () => {})
      socket.on('error', resolve)
    })

    controller.respondWith(new Response(error.message))
  })

  const response = await fetch(
    `http://127.0.0.1:${await getClosedPort()}/resource`
  )

  await expect(response.text()).resolves.toBe('lookup failed')
})
