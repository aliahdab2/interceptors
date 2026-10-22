// @vitest-environment node
/**
 * @see https://github.com/mswjs/interceptors/issues/862
 */
import http from 'node:http'
import net from 'node:net'
import { HttpRequestInterceptor } from '#/src/interceptors/http'
import { createRawTestServer, getClosedPort } from '#/test/helpers'

const interceptor = new HttpRequestInterceptor()

beforeAll(() => {
  interceptor.apply()
})

afterEach(() => {
  interceptor.removeAllListeners()
})

afterAll(() => {
  interceptor.dispose()
})

/**
 * Send a request whose bytes are written well after the client
 * starts reading its new connection.
 */
function requestEndedLate(
  url: string,
  delay: number
): Promise<{ status?: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request(url, {
      method: 'POST',
      agent: new http.Agent(),
    })
    request.on('response', (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => (body += chunk))
      response.on('end', () => resolve({ status: response.statusCode, body }))
    })
    request.on('error', reject)
    setTimeout(() => request.end('hello'), delay)
  })
}

it('intercepts a request written late to a new connection', async () => {
  const requestListener = vi.fn<(request: Request) => void>()
  interceptor.on('request', ({ request, controller }) => {
    requestListener(request)
    controller.respondWith(new Response('mocked'))
  })

  const url = `http://127.0.0.1:${await getClosedPort()}/resource`

  await expect(requestEndedLate(url, 20)).resolves.toEqual({
    status: 200,
    body: 'mocked',
  })
  expect(requestListener).toHaveBeenCalledOnce()
  expect(requestListener.mock.calls[0][0].url).toBe(url)
})

it('makes no real connection for a request written late that gets mocked', async () => {
  const connectionListener = vi.fn()
  await using server = await createRawTestServer(() => {
    return new net.Server((connection) => {
      connectionListener()
      connection.end()
    })
  })

  interceptor.on('request', ({ controller }) => {
    controller.respondWith(new Response('mocked'))
  })

  await expect(
    requestEndedLate(`http://${server.hostname}:${server.port}/resource`, 20)
  ).resolves.toEqual({ status: 200, body: 'mocked' })
  expect(connectionListener).not.toHaveBeenCalled()
})

it('passes a request written late through to the real server', async () => {
  const connectionListener = vi.fn()
  await using server = await createRawTestServer(() => {
    return http
      .createServer((request, response) => {
        request.resume().on('end', () => response.end('original'))
      })
      .on('connection', connectionListener)
  })

  const requestListener = vi.fn()
  interceptor.on('request', requestListener)

  await expect(
    requestEndedLate(server.http.url('/resource').href, 20)
  ).resolves.toEqual({ status: 200, body: 'original' })
  expect(requestListener).toHaveBeenCalledOnce()
  expect(connectionListener).toHaveBeenCalledOnce()
})

it('still reports a refused connection to a reading client that is not an HTTP client', async () => {
  const port = await getClosedPort()

  const error = await new Promise<NodeJS.ErrnoException>((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1')
    socket.on('data', () => reject(new Error('must not receive any data')))
    socket.on('error', resolve)
  })

  expect(error.code).toBe('ECONNREFUSED')
})
