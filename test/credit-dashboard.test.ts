import { afterEach, describe, expect, it, vi } from 'vitest'
import { runInNewContext, Script } from 'node:vm'
import app from '../src/index'
import { creditDashboardScript } from '../src/credit-dashboard-client'

class Element {
  value = ''; textContent = ''; className = ''; hidden = false; disabled = false
  dataset: Record<string,string> = {}
  children: Element[] = []
  handlers: Record<string,(event?: any)=>void> = {}
  append(...elements: Element[]) { this.children.push(...elements) }
  replaceChildren(...elements: Element[]) { this.children = elements }
  setAttribute() {}
  focus() {}
  addEventListener(name: string, callback: (event?:any)=>void) { this.handlers[name] = callback }
  fire(name: string) { this.handlers[name]?.({preventDefault(){}}) }
  // No innerHTML implementation: received data must use text nodes.
  set innerHTML(_value: string) { throw new Error('Unsafe HTML insertion') }
}
const contact = {name:'Pessoa de teste',email:'teste@example.com',phoneNumber:'71999999999',birthDate:'1990-05-20',taxNumber:'00000000000'}
const response = (items: unknown[], total = items.length, page = 1, pageSize = 20) => new Response(JSON.stringify({items,total,page,pageSize}),{status:200})
async function flush() { for (let i=0;i<12;i++) await Promise.resolve() }
function mount(fetchMock = vi.fn()) {
  vi.useFakeTimers()
  const elements = new Map<string,Element>()
  const get = (id: string) => { if (!elements.has(id)) elements.set(id,new Element()); return elements.get(id)! }
  const listeners: Record<string,()=>void> = {}
  const document = {hidden:false,getElementById:get,createElement:()=>new Element(),addEventListener:(key:string,fn:()=>void)=>{listeners[key]=fn}}
  const windowEvents: Record<string,()=>void> = {}
  runInNewContext(creditDashboardScript,{document,window:{addEventListener:(key:string,fn:()=>void)=>{windowEvents[key]=fn}},fetch:fetchMock,setTimeout,clearTimeout,AbortController,Intl,Map,Date,JSON,Number,String,Error})
  const login = async () => {get('client-id').value='reader-test';get('api-key').value='test-key';get('login-form').fire('submit');await flush()}
  return {get,document,listeners,windowEvents,login,fetchMock}
}
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks()})
describe('credit dashboard',()=>{
  it('serves a public shell without lead data and same-origin script protections',async()=>{
    const r=await app.request('http://localhost/leads/credit')
    expect(r.status).toBe(200);expect(r.headers.get('cache-control')).toBe('no-store')
    expect(r.headers.get('content-security-policy')).toContain("connect-src 'self'")
    const html=await r.text();expect(html).toContain('/assets/credit-leads.js');expect(html).not.toContain('7250b76b')
    const asset=await app.request('http://localhost/assets/credit-leads.js');expect(asset.status).toBe(200)
    expect(()=>new Script(creditDashboardScript)).not.toThrow()
  })
  it('authenticates, polls real API data, and renders only five fields safely',async()=>{
    const fetchMock=vi.fn().mockResolvedValueOnce(response([contact])).mockResolvedValueOnce(response([{...contact,name:'<img src=x onerror=alert(1)>'},contact],2))
    const s=mount(fetchMock);await s.login()
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/credit-leads?page=1&page_size=20')
    expect(fetchMock.mock.calls[0]![1].headers).toEqual({'X-Client-Id':'reader-test','X-API-Key':'test-key'})
    expect(s.get('api-key').value).toBe('');expect(s.get('dashboard').hidden).toBe(false)
    expect(s.get('rows').children[0]!.children).toHaveLength(5)
    await vi.advanceTimersByTimeAsync(5000)
    expect(s.get('total').textContent).toBe('2');expect(s.get('rows').children).toHaveLength(2)
    expect(s.get('rows').children[0]!.children[0]!.children[0]!.children[1]!.textContent).toBe('<img src=x onerror=alert(1)>')
    expect(s.get('rows').children[0]!.className).toBe('fresh')
    expect(s.get('message-text').textContent).toContain('Um novo lead')
  })
  it.each([401,403])('rejects invalid or unauthorized credentials (%s) without polling',async status=>{
    const s=mount(vi.fn().mockResolvedValue(new Response('{}',{status})));await s.login()
    expect(s.get('login-error').hidden).toBe(false);expect(s.get('rows').children).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(20000);expect(s.fetchMock).toHaveBeenCalledTimes(1)
  })
  it('respects Retry-After and keeps a visible warning for stale results',async()=>{
    const s=mount(vi.fn().mockResolvedValueOnce(response([contact])).mockResolvedValueOnce(new Response('{}',{status:503,headers:{'Retry-After':'10'}})).mockResolvedValue(response([contact])))
    await s.login();await vi.advanceTimersByTimeAsync(5000)
    expect(s.get('message').className).toBe('banner error');expect(s.get('rows').children).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(5000);expect(s.fetchMock).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(5000);expect(s.fetchMock).toHaveBeenCalledTimes(3)
    expect(s.get('message').hidden).toBe(true)
  })
  it('clears displayed personal data and stops polling on logout',async()=>{
    const s=mount(vi.fn().mockResolvedValue(response([contact])));await s.login();s.get('logout').fire('click')
    expect(s.get('rows').children).toHaveLength(0);expect(s.get('dashboard').hidden).toBe(true)
    expect(s.get('api-key').value).toBe('');await vi.advanceTimersByTimeAsync(20000);expect(s.fetchMock).toHaveBeenCalledTimes(1)
  })
  it('uses API pagination and searches only the current page',async()=>{
    const s=mount(vi.fn().mockResolvedValueOnce(response([contact],21)).mockResolvedValueOnce(response([{...contact,name:'Outra pessoa'}],21,2)))
    await s.login();s.get('next').fire('click');await flush()
    expect(s.fetchMock.mock.calls[1]![0]).toBe('/api/credit-leads?page=2&page_size=20')
    s.get('search').value='inexistente';s.get('search').fire('input')
    expect(s.get('rows').children).toHaveLength(0);expect(s.get('state-description').textContent).toContain('desta página')
  })
  it('pauses polling while the tab is hidden and refreshes on return',async()=>{
    const s=mount(vi.fn().mockImplementation(()=>Promise.resolve(response([contact]))));await s.login()
    s.document.hidden=true;s.listeners.visibilitychange!();await vi.advanceTimersByTimeAsync(20000)
    expect(s.fetchMock).toHaveBeenCalledTimes(1)
    s.document.hidden=false;s.listeners.visibilitychange!();await flush();expect(s.fetchMock).toHaveBeenCalledTimes(2)
  })
  it('does not mistake identical contact data for a unique lead',async()=>{
    const s=mount(vi.fn().mockResolvedValueOnce(response([contact])).mockResolvedValueOnce(response([contact,contact],2)))
    await s.login();await vi.advanceTimersByTimeAsync(5000)
    expect(s.get('rows').children).toHaveLength(2)
    expect(s.get('rows').children.filter(row=>row.className==='fresh')).toHaveLength(1)
  })
})
