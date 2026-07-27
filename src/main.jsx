import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import logo from './assets/jh-artworks-logo.png'

const DEFAULT_HEADER = `%
(NC COMBINED)
G64
G90 G94
G21

G53
G0 Z0`

const DEFAULT_FOOTER = `M9
G53
G0 Z0
G28
M30
%`

const DEFAULT_PROFILE = { id: 'beamicon', name: 'Beamicon / Benezan', header: DEFAULT_HEADER, footer: DEFAULT_FOOTER, dwell_template: 'G4 H{seconds}' }
const downloadExtensionFor = (profile) => { const name = String(profile?.name || '').toLowerCase(); if (name.includes('linuxcnc')) return 'ngc'; if (name.includes('estlcam') || name.includes('eding')) return 'nc'; return profile?.extension || 'din' }
const STORAGE_KEY = 'nc-combiner-profiles-v1'

const uid = () => globalThis.crypto?.randomUUID?.() || ('nc-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 11))
const OPERATION_COLORS = ['#64d8ff', '#8fe388', '#ff9d6c', '#d49bff', '#ffd76b', '#ff82b2', '#78b8ff']
const randomOperationColor = () => OPERATION_COLORS[Math.floor(Math.random() * OPERATION_COLORS.length)]
const normalise = (text) => text.replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '')
const numeric = (value) => value === '' || value == null ? '' : String(value).trim()
const blankPlaceholder = (afterOperationId) => ({ id: uid(), afterOperationId, mode: 'blank', lines: 5, value: '1', command: '', content: '', filename: '' })
function placeholderOutput(placeholder, dwellTemplate = 'G4 H{seconds}') {
  if (!placeholder) return ''
  const marker = '\n(Zwischenschritt, generiert mit NC-Combiner)\n'
  if (placeholder.mode === 'blank') return marker + '\n'.repeat(Math.max(1, Math.min(50, Number(placeholder.lines) || 5)))
  if (placeholder.mode === 'dwell') return marker + String(dwellTemplate || 'G4 H{seconds}').replaceAll('{seconds}', numeric(placeholder.value) || '1')
  if (placeholder.mode === 'm2') return marker + 'M2'
  if (placeholder.mode === 'custom') return placeholder.command?.trim() ? marker + placeholder.command.trim() : ''
  if (placeholder.mode === 'file') return placeholder.content?.trim() ? marker + placeholder.content.trim() : ''
  return ''
}

function findProgramEdges(source) {
  const lines = normalise(source).split('\n')
  const firstOperation = lines.findIndex((line, i) => i > 4 && /^\([^)]{1,120}\)\s*$/.test(line.trim()) && !/^\(T\d+\b/i.test(line.trim()))
  const firstToolChange = lines.findIndex((line) => /\bT\d+\s*M6\b/i.test(line))
  const bodyStart = [firstOperation, firstToolChange].filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0
  let bodyEnd = lines.length
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^M30\b/i.test(lines[i].trim())) { bodyEnd = Math.max(0, i - 3); break }
  }
  return { body: lines.slice(bodyStart, bodyEnd).join('\n').trim(), header: lines.slice(0, bodyStart).join('\n').trim() }
}

function discoverOperations(body) {
  const lines = body.split('\n')
  const starts = lines.map((line, index) => ({ line: line.trim(), index }))
    .filter(({ line }) => /^\([^)]{1,120}\)$/.test(line) && !/^\(T\d+\b/i.test(line))
  return starts.map(({ line, index }, position) => {
    const end = starts[position + 1]?.index ?? lines.length
    const part = lines.slice(index, end).join('\n')
    const tool = part.match(/\bT(\d+)\s*M6\b/i)?.[1] ?? ''
    return { id: uid(), name: line.slice(1, -1), tool, color: randomOperationColor() }
  })
}

function parseProgram(file, text) {
  const { body } = findProgramEdges(text)
  const feeds = [...body.matchAll(/\bF([0-9]+(?:\.[0-9]+)?)/gi)].map((m) => m[1])
  const speeds = [...body.matchAll(/\bS([0-9]+(?:\.[0-9]+)?)/gi)].map((m) => m[1])
  const offset = body.match(/\bG5([4-9])\b/i)?.[0]?.toUpperCase() ?? 'G54'
  const values = (items) => [...new Set(items)].map((value) => ({ original: value, value }))
  const operations = discoverOperations(body)
  return { id: uid(), filename: file.name, body, operations, placeholders: [blankPlaceholder('__section_end__')], feedValues: values(feeds), speedValues: values(speeds), offset, enabled: true }
}

function parseToolTable(text, filename) {
  const raw = normalise(text).trim()
  if (filename.toLowerCase().endsWith('.json')) {
    const json = JSON.parse(raw)
    const rows = Array.isArray(json) ? json : json.tools || json.data || []
    return rows.map((row) => ({ number: String(row.tool ?? row.toolNumber ?? row.number ?? row.nummer ?? row.id ?? ''), name: String(row.name ?? row.bezeichnung ?? row.description ?? '') })).filter((x) => /^\d+$/.test(x.number))
  }
  const lines = raw.split('\n').filter(Boolean)
  const delimiter = lines[0]?.includes(';') ? ';' : lines[0]?.includes('\t') ? '\t' : ','
  const header = lines[0]?.toLowerCase().split(delimiter).map((cell) => cell.trim()) || []
  const numberIndex = header.findIndex((cell) => /tool|werkzeug|nummer|number|nr/.test(cell))
  const nameIndex = header.findIndex((cell) => /name|bezeichnung|description|typ/.test(cell))
  const fromRows = lines.slice(numberIndex >= 0 ? 1 : 0).map((line) => {
    const cells = line.split(delimiter).map((cell) => cell.trim().replace(/^"|"$/g, ''))
    const number = numberIndex >= 0 ? cells[numberIndex] : (line.match(/(?:T|tool\s*)?(\d+)/i)?.[1] ?? '')
    return { number: number.replace(/^T/i, ''), name: nameIndex >= 0 ? cells[nameIndex] : cells.slice(1).join(' ') }
  })
  return fromRows.filter((x) => /^\d+$/.test(x.number))
}


function replaceSection(section, profile) {
  let output = section.body
  const feedMap = Object.fromEntries((section.feedValues || []).map((item) => [item.original, numeric(item.value)]))
  const speedMap = Object.fromEntries((section.speedValues || []).map((item) => [item.original, numeric(item.value)]))
  output = output.replace(/\bF([0-9]+(?:\.[0-9]+)?)/gi, (match, value) => feedMap[value] ? 'F' + feedMap[value] : match)
  output = output.replace(/\bS([0-9]+(?:\.[0-9]+)?)/gi, (match, value) => speedMap[value] ? 'S' + speedMap[value] : match)
  output = output.replace(/\bG5[4-9]\b/gi, section.offset)
  section.operations.forEach((operation) => {
    if (!operation.tool) return
    const escaped = operation.name.replace(/[.*+?^$()|[\]\\]/g, '\\$&')
    const block = new RegExp('(\\(' + escaped + '\\)[\\s\\S]*?)(?=\\n\\([^)]{1,120}\\)\\s*$|$)', 'im')
    output = output.replace(block, (match) => match.replace(/\bT\d+(?=\s*M6\b)/gi, 'T' + operation.tool))
  })
  const sectionInsert = (section.placeholders || []).filter((item) => item.afterOperationId === '__section_end__').sort((a, b) => (a.order || 0) - (b.order || 0)).map((item) => placeholderOutput(item, profile?.dwell_template)).join('')
  return output + sectionInsert
}
function applyAliases(output, aliases) {
  return aliases.reduce((text, item) => {
    const escaped = String(item.alias || '').replace(/[.*+?^$()|[\]\\]/g, '\\$&')
    return escaped ? text.replace(new RegExp('\\b' + escaped + '\\b', 'g'), item.replacement) : text
  }, output)
}

function App() {
function applyControllerRules(output, profile) { if (!/estlcam/i.test(profile?.name || '')) return output; return output.split('\n').map((line) => line.replace(/\bG(?:28|43|53|54|55|56|57|58|59|64)\b/gi, '').replace(/\bH\d+\b/gi, '').replace(/\s{2,}/g, ' ').trim()).filter(Boolean).join('\n') }
function buildToolpaths(program, operationColors) {
  let x = 0, y = 0, z = 0, mode = 'G0', activeColor = null, activeOperation = null
  const rapid = [], cut = [], routes = []
  program.split('\n').forEach((raw) => {
    const comment = raw.match(/^\s*\(([^)]{1,120})\)\s*$/)
    if (comment && operationColors[comment[1]]) { activeColor = operationColors[comment[1]]; activeOperation = comment[1] }
    const line = raw.replace(/\([^)]*\)/g, '')
    const command = line.match(/\bG0?([0-3])\b/i)
    if (command) mode = 'G' + command[1]
    const nextX = line.match(/\bX(-?[\d.]+)/i), nextY = line.match(/\bY(-?[\d.]+)/i), nextZ = line.match(/\bZ(-?[\d.]+)/i)
    if (!nextX && !nextY && !nextZ) return
    const to = { x: nextX ? Number(nextX[1]) : x, y: nextY ? Number(nextY[1]) : y, z: nextZ ? Number(nextZ[1]) : z }
    const addPath = (target, points) => { points.color = activeColor; points.operation = activeOperation; points.rapid = target === rapid; target.push(points); routes.push(points) }
    if (mode === 'G2' || mode === 'G3') {
      const i = Number(line.match(/\bI(-?[\d.]+)/i)?.[1] || 0), j = Number(line.match(/\bJ(-?[\d.]+)/i)?.[1] || 0)
      const center = { x: x + i, y: y + j }, start = Math.atan2(y - center.y, x - center.x), end = Math.atan2(to.y - center.y, to.x - center.x), radius = Math.hypot(x - center.x, y - center.y)
      let sweep = end - start
      if (mode === 'G2' && sweep >= 0) sweep -= Math.PI * 2
      if (mode === 'G3' && sweep <= 0) sweep += Math.PI * 2
      const steps = Math.max(3, Math.ceil(Math.abs(sweep) / (Math.PI / 18)))
      const arc = Array.from({ length: steps + 1 }, (_, n) => { const a = start + sweep * n / steps, ratio = n / steps; return { x: center.x + Math.cos(a) * radius, y: center.y + Math.sin(a) * radius, z: z + (to.z - z) * ratio } })
      addPath(cut, arc)
    } else addPath(mode === 'G0' ? rapid : cut, [{ x, y, z }, to])
    x = to.x; y = to.y; z = to.z
  })
  return { rapid, cut, routes }
}
function ToolpathPreview({ program, operationColors = {}, idle = false }) {
  const [rotation, setRotation] = useState({ yaw: 0, pitch: 0 })
  const [detail, setDetail] = useState(0)
  const [dragging, setDragging] = useState(false)
  const [simulationIndex, setSimulationIndex] = useState(null)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const drag = useRef(null)
  const preview = useMemo(() => {
    const { rapid, cut, routes } = buildToolpaths(program, operationColors)
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, hasPoints = false
    for (const group of [rapid, cut]) for (const path of group) for (const point of path) { hasPoints = true; minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x); minY = Math.min(minY, point.y); maxY = Math.max(maxY, point.y) }
    return { rapid, cut, routes, totalCut: cut.length, hasPoints, minX, maxX, minY, maxY }
  }, [program, operationColors])
  useEffect(() => {
    setRotation({ yaw: 0, pitch: 0 }); setDetail(0); setSimulationIndex(null); setPlaying(false)
    const total = Math.max(preview.routes.length, 1)
    let current = Math.min(300, total), timer
    const revealMore = () => { setDetail(current); if (current >= total) return; current = Math.min(total, Math.max(current + 500, Math.ceil(current * 1.65))); timer = window.setTimeout(revealMore, 110) }
    timer = window.setTimeout(revealMore, 30)
    return () => window.clearTimeout(timer)
  }, [program, preview.routes.length])
  const totalPaths = Math.max(preview.routes.length, 1), fullyLoaded = detail >= totalPaths
  useEffect(() => {
    if (!playing || !fullyLoaded) return
    const timer = window.setInterval(() => setSimulationIndex((current) => { const position = current == null ? 0 : current; const next = Math.min(totalPaths, position + Math.max(1, Math.round(Number(speed) * 4))); if (next >= totalPaths) setPlaying(false); return next }), 120)
    return () => window.clearInterval(timer)
  }, [playing, speed, fullyLoaded, totalPaths])
  const progress = Math.min(1, detail / totalPaths)
  const loadingRoutes = preview.routes.slice(0, Math.ceil(preview.routes.length * progress))
  const visibleRoutes = fullyLoaded && simulationIndex != null ? preview.routes.slice(0, simulationIndex) : loadingRoutes
  const shownRapid = visibleRoutes.filter((route) => route.rapid), shownCut = visibleRoutes.filter((route) => !route.rapid)
  const operationStarts = useMemo(() => preview.routes.reduce((starts, route, index) => { if (route.operation && (index === 0 || preview.routes[index - 1].operation !== route.operation)) starts.push(index); return starts }, []), [preview.routes])
  const jumpOperation = (direction) => { const position = simulationIndex == null ? totalPaths : simulationIndex; const candidates = direction > 0 ? operationStarts.filter((index) => index > position) : operationStarts.filter((index) => index < Math.max(0, position - 1)); setSimulationIndex(direction > 0 ? (candidates[0] ?? totalPaths) : (candidates[candidates.length - 1] ?? 0)); setPlaying(false) }
  const togglePlay = () => { if (simulationIndex == null || simulationIndex >= totalPaths) setSimulationIndex(0); setPlaying((value) => !value || simulationIndex == null || simulationIndex >= totalPaths) }
  const scene = useMemo(() => {
    const yaw = rotation.yaw * Math.PI / 180, pitch = rotation.pitch * Math.PI / 180
    const cx = (preview.minX + preview.maxX) / 2, cy = (preview.minY + preview.maxY) / 2
    const project = (point) => { const dx = point.x - cx, dy = point.y - cy, dz = point.z || 0, x1 = dx * Math.cos(yaw) + dz * Math.sin(yaw), z1 = -dx * Math.sin(yaw) + dz * Math.cos(yaw), y1 = dy * Math.cos(pitch) - z1 * Math.sin(pitch); return { x: x1, y: -y1 } }
    const mapRoute = (path) => ({ points: path.map(project), color: path.color })
    const rapid = shownRapid.map(mapRoute), cut = shownCut.map(mapRoute)
    const axisLength = Math.max(preview.maxX - preview.minX, preview.maxY - preview.minY, 1) * .12
    const origin = project({ x: 0, y: 0, z: 0 }), axes = { x: project({ x: axisLength, y: 0, z: 0 }), y: project({ x: 0, y: axisLength, z: 0 }), z: project({ x: 0, y: 0, z: axisLength }) }
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    const include = (point) => { minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x); minY = Math.min(minY, point.y); maxY = Math.max(maxY, point.y) }
    for (const group of [rapid, cut]) for (const path of group) for (const point of path.points) include(point)
    include(origin); include(axes.x); include(axes.y); include(axes.z)
    const pad = Math.max((maxX - minX) * .08, (maxY - minY) * .08, 1), width = Math.max(maxX - minX + pad * 2, 1), height = Math.max(maxY - minY + pad * 2, 1)
    const gizmoOrigin = { x: minX + pad + width * .07, y: minY + pad + height * .11 }, gizmoScale = Math.max(width, height) * .08
    const toGizmo = (point) => ({ x: gizmoOrigin.x + (point.x - origin.x) / axisLength * gizmoScale, y: gizmoOrigin.y + (point.y - origin.y) / axisLength * gizmoScale })
    const cutByColor = cut.reduce((groups, route) => { const color = route.color || '#80d99b'; (groups[color] ||= []).push(route.points); return groups }, {})
    const cubeSize = Math.min(width, height) * .07
    return { rapid, cutByColor, origin, axes, gizmo: { origin: gizmoOrigin, x: toGizmo(axes.x), y: toGizmo(axes.y), z: toGizmo(axes.z) }, cube: { x: minX - pad + width - cubeSize * 1.35, y: minY - pad + cubeSize * 1.35, size: cubeSize }, viewBox: [minX - pad, minY - pad, width, height].join(' ') }
  }, [preview, shownRapid, shownCut, rotation])
  if (idle || !preview.hasPoints) return <div className="idle-preview"><img src={logo} alt="JH Artworks" /></div>
  const pathData = (lines) => lines.map((line) => line.length ? 'M' + line.map((point) => point.x + ',' + point.y).join(' L') : '').join(' ')
  const axisLine = (from, to, className, label) => <g className={className}><line x1={from.x} y1={from.y} x2={to.x} y2={to.y} /><text x={to.x} y={to.y}>{label}</text></g>
  const setView = (yaw, pitch) => setRotation({ yaw, pitch })
  const cubeAction = (event, yaw, pitch) => { event.preventDefault(); event.stopPropagation(); drag.current = null; setDragging(false); setView(yaw, pitch) }
  const viewCube = () => { const c = scene.cube, p = (x, y) => ({ x: c.x + x * c.size, y: c.y + y * c.size }), textPoint = (point) => point.x + ',' + point.y, corners = { top: p(0, -1), rightTop: p(1, -.5), rightBottom: p(1, .5), bottom: p(0, 1), leftBottom: p(-1, .5), leftTop: p(-1, -.5), middle: p(0, 0) }, face = (className, points, yaw, pitch, title) => <polygon className={className} points={points.map(textPoint).join(' ')} onPointerDown={(event) => cubeAction(event, yaw, pitch)} onClick={(event) => cubeAction(event, yaw, pitch)}><title>{title}</title></polygon>, edge = (a, b, yaw, pitch, title) => <g><line className="cube-edge" x1={a.x} y1={a.y} x2={b.x} y2={b.y} /><line className="cube-edge-hit" x1={a.x} y1={a.y} x2={b.x} y2={b.y} style={{ pointerEvents: 'all' }} onPointerDown={(event) => cubeAction(event, yaw, pitch)} onClick={(event) => cubeAction(event, yaw, pitch)}><title>{title}</title></line></g>, corner = (point, yaw, pitch, title) => <circle className="cube-corner" cx={point.x} cy={point.y} r={c.size * .13} onPointerDown={(event) => cubeAction(event, yaw, pitch)} onClick={(event) => cubeAction(event, yaw, pitch)}><title>{title}</title></circle>; return <g className="view-cube" aria-label="Ansicht ausw?hlen">{face('cube-face cube-top', [corners.top, corners.rightTop, corners.middle, corners.leftTop], 0, 0, 'Ansicht von oben')}{face('cube-face cube-left', [corners.leftTop, corners.middle, corners.bottom, corners.leftBottom], -70, 35, 'Linke Schraegansicht')}{face('cube-face cube-right', [corners.middle, corners.rightTop, corners.rightBottom, corners.bottom], 70, 35, 'Rechte Schraegansicht')}{edge(corners.top, corners.rightTop, 45, 0, 'Obere rechte Kante')}{edge(corners.rightTop, corners.rightBottom, 90, 0, 'Rechte Kante')}{edge(corners.rightBottom, corners.bottom, 70, -35, 'Untere rechte Kante')}{edge(corners.bottom, corners.leftBottom, 180, 0, 'Untere Kante')}{edge(corners.leftBottom, corners.leftTop, -90, 0, 'Linke Kante')}{edge(corners.leftTop, corners.top, -45, 0, 'Obere linke Kante')}{edge(corners.leftTop, corners.middle, -45, 35, 'Linke Innenkante')}{edge(corners.middle, corners.rightTop, 45, 35, 'Rechte Innenkante')}{edge(corners.middle, corners.bottom, 0, 60, 'Vordere Innenkante')}{corner(corners.top, 0, 0, 'Oben')}{corner(corners.rightTop, 45, 45, 'Oben rechts')}{corner(corners.rightBottom, 45, -45, 'Unten rechts')}{corner(corners.bottom, 180, 0, 'Unten')}{corner(corners.leftBottom, -45, -45, 'Unten links')}{corner(corners.leftTop, -45, 45, 'Oben links')}{corner(corners.middle, 0, 60, 'Vorne')}</g> }
  const startDrag = (event) => { drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, yaw: rotation.yaw, pitch: rotation.pitch }; event.currentTarget.setPointerCapture(event.pointerId); setDragging(true) }
  const moveDrag = (event) => { const active = drag.current; if (!active || active.id !== event.pointerId) return; setRotation({ yaw: active.yaw + (event.clientX - active.x) * .45, pitch: Math.max(-75, Math.min(75, active.pitch - (event.clientY - active.y) * .45)) }) }
  const endDrag = (event) => { if (drag.current?.id !== event.pointerId) return; drag.current = null; setDragging(false); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId) }
  return <div className="path-preview"><div className="path-legend"><span><i className="cut-dot" />Fr&auml;sweg</span><span><i className="rapid-dot" />Eilgang</span><span><i className="origin-dot" />Nullpunkt</span><span>{preview.totalCut} Bearbeitungsz&uuml;ge</span>{!fullyLoaded && <span className="preview-note">Vorschau wird vollst&auml;ndig geladen...</span>}</div>{fullyLoaded && <div className="simulation-controls"><button className="secondary" onClick={() => { setSimulationIndex(0); setPlaying(false) }} title="Zum Anfang">|&lt;</button><button className="secondary" onClick={() => jumpOperation(-1)}>Zur&uuml;ck</button><button className="primary" onClick={togglePlay}>{playing ? 'Pause' : 'Play'}</button><button className="secondary" onClick={() => jumpOperation(1)}>Weiter</button><button className="secondary" onClick={() => { setSimulationIndex(totalPaths); setPlaying(false) }} title="Zum Ende">&gt;|</button><label>Tempo<input type="range" min="0.25" max="8" step="0.25" value={speed} onChange={(event) => setSpeed(event.target.value)} /><span>{speed}x</span></label></div>}<svg className={dragging ? 'dragging' : ''} viewBox={scene.viewBox} role="img" aria-label="Interaktive dreidimensionale G-Code-Bahnansicht" preserveAspectRatio="xMidYMid meet" onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}><path d={pathData(scene.rapid.map((route) => route.points))} className="rapid-path" />{Object.entries(scene.cutByColor).map(([color, routes]) => <path key={color} d={pathData(routes)} className="cut-path" style={{ stroke: color }} />)}<g className="work-origin"><circle cx={scene.origin.x} cy={scene.origin.y} r="3" /></g><g className="axis-gizmo">{axisLine(scene.gizmo.origin, scene.gizmo.x, 'axis-x', 'X')}{axisLine(scene.gizmo.origin, scene.gizmo.y, 'axis-y', 'Y')}{axisLine(scene.gizmo.origin, scene.gizmo.z, 'axis-z', 'Z')}<circle cx={scene.gizmo.origin.x} cy={scene.gizmo.origin.y} r="2" /></g>{viewCube()}</svg></div> }

  const [sections, setSections] = useState([])
  const [tools, setTools] = useState([])
  const [profiles, setProfiles] = useState([DEFAULT_PROFILE])
  const [aliases, setAliases] = useState([])
  const [profileId, setProfileId] = useState('beamicon')
  const [downloadFormat, setDownloadFormat] = useState('')
  const [whiteFlash, setWhiteFlash] = useState(false)
  const [whiteMessage, setWhiteMessage] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [adminOpen, setAdminOpen] = useState(false)
  const [adminSession, setAdminSession] = useState(false)
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [userAdminOpen, setUserAdminOpen] = useState(false)
  const [account, setAccount] = useState(null)
  const [libraryPreview, setLibraryPreview] = useState('')
  const [previewMode, setPreviewMode] = useState('graphic')
  const [dragId, setDragId] = useState(null)
  const [fileDropActive, setFileDropActive] = useState(false)
  const fileRef = useRef()
  const toolRef = useRef()
  const profile = profiles.find((item) => String(item.id) === String(profileId)) || profiles[0]
  const selectedDownloadFormat = downloadFormat || downloadExtensionFor(profile)
  const operationColors = useMemo(() => Object.fromEntries(sections.flatMap((section) => section.operations.map((operation) => [operation.name, operation.color || '#80d99b']))), [sections])

  useEffect(() => { Promise.all([fetch('/api/profiles').then((r) => r.ok ? r.json() : []), fetch('/api/aliases').then((r) => r.ok ? r.json() : [])]).then(([items, aliasItems]) => { if (items.length) { setProfiles(items); setProfileId((old) => items.some((item) => String(item.id) === String(old)) ? old : String(items[0].id)) }; setAliases(aliasItems) }).catch(() => {}) }, [])
  useEffect(() => { fetch('/api/auth/me').then((r) => r.ok ? r.json() : null).then(setAccount).catch(() => {}) }, [])
  useEffect(() => { fetch('/api/admin/me').then((r) => setAdminSession(r.ok)).catch(() => {}) }, [])
  const result = useMemo(() => {
    const combinedTitle = '(Combined NC Code | NC-Combiner by J.H. Artworks )'
    const parts = sections.filter((section) => section.enabled).map((section) => replaceSection(section, profile)).map((body) => applyControllerRules(applyAliases(body, aliases), profile)).filter(Boolean).map((body) => [body, combinedTitle].join('\n'))
    const header = profile?.header.trim() || ''
    const titledHeader = header.startsWith('%') ? header.replace(/^%/, `%\n${combinedTitle}`) : [combinedTitle, header].filter(Boolean).join('\n')
    const footer = (profile?.footer.trim() || '').replace(/^M30\b/im, `${combinedTitle}\nM30`)
    return [titledHeader, ...parts, footer].filter(Boolean).join('\n\n') + '\n'
  }, [sections, profile, aliases])
  const previewProgram = libraryPreview || result

  async function addFiles(fileList) {
    const files = [...(fileList || [])].filter((file) => /\.(din|nc|tap|txt)$/i.test(file.name))
    if (!files.length) return
    try {
      const imported = await Promise.all(files.map(async (file) => parseProgram(file, await file.text())))
      setSections((old) => {
        const used = new Set(old.flatMap((section) => section.operations.map((operation) => operation.color)).filter(Boolean))
        let cursor = old.flatMap((section) => section.operations).length % OPERATION_COLORS.length
        const nextColor = () => {
          for (let attempt = 0; attempt < OPERATION_COLORS.length; attempt++) {
            const color = OPERATION_COLORS[(cursor + attempt) % OPERATION_COLORS.length]
            if (!used.has(color)) { used.add(color); cursor = (cursor + attempt + 1) % OPERATION_COLORS.length; return color }
          }
          return OPERATION_COLORS[cursor++ % OPERATION_COLORS.length]
        }
        return [...old, ...imported.map((section) => ({ ...section, operations: section.operations.map((operation) => ({ ...operation, color: nextColor() })) }))]
      })
    } catch (error) { console.error('NC-Datei konnte nicht verarbeitet werden:', error); alert('NC-Datei konnte nicht verarbeitet werden: ' + (error?.message || 'Unbekannter Fehler')) }
  }
  function isFileDrag(event) { return Array.from(event.dataTransfer?.types || []).includes('Files') }
  function handleFileDrop(event) { if (!isFileDrag(event)) return; event.preventDefault(); setFileDropActive(false); addFiles(event.dataTransfer.files) }

  function updateSection(id, updates) { setSections((old) => old.map((section) => section.id === id ? { ...section, ...updates } : section)) }
  function updateOperation(sectionId, operationId, updates) {
    setSections((old) => old.map((section) => section.id !== sectionId ? section : { ...section, operations: section.operations.map((op) => op.id === operationId ? { ...op, ...updates } : op) }))
  }
  function updatePlaceholder(sectionId, placeholderId, updates) {
    setSections((old) => old.map((section) => section.id !== sectionId ? section : { ...section, placeholders: (section.placeholders || []).map((item) => item.id === placeholderId ? { ...item, ...updates } : item) }))
  }
  function addPlaceholder(sectionId, afterOperationId) {
    setSections((old) => old.map((section) => {
      if (section.id !== sectionId) return section
      const group = (section.placeholders || []).filter((item) => item.afterOperationId === afterOperationId)
      const next = { ...blankPlaceholder(afterOperationId), order: group.length ? Math.max(...group.map((item) => item.order || 0)) + 1 : 0 }
      return { ...section, placeholders: [...(section.placeholders || []), next] }
    }))
  }
  function removePlaceholder(sectionId, placeholderId) {
    setSections((old) => old.map((section) => section.id !== sectionId ? section : { ...section, placeholders: (section.placeholders || []).filter((item) => item.id !== placeholderId) }))
  }
  function movePlaceholder(sectionId, afterOperationId, fromId, toId) {
    if (fromId === toId) return
    setSections((old) => old.map((section) => {
      if (section.id !== sectionId) return section
      const all = section.placeholders || []
      const group = all.filter((item) => item.afterOperationId === afterOperationId)
      const from = group.findIndex((item) => item.id === fromId), to = group.findIndex((item) => item.id === toId)
      if (from < 0 || to < 0) return section
      const reordered = [...group], [item] = reordered.splice(from, 1)
      reordered.splice(to, 0, item)
      const ordered = new Map(reordered.map((item, index) => [item.id, index]))
      return { ...section, placeholders: all.map((item) => item.afterOperationId === afterOperationId ? { ...item, order: ordered.get(item.id) } : item) }
    }))
  }
  function move(from, to) { setSections((old) => { const next = [...old]; const [item] = next.splice(from, 1); next.splice(to, 0, item); return next }) }
  function download() { const url = URL.createObjectURL(new Blob([result], { type: 'text/plain;charset=utf-8' })); const a = document.createElement('a'); a.href = url; a.download = 'combined.' + selectedDownloadFormat; a.click(); URL.revokeObjectURL(url) }
  function flashWhiteMode() { setWhiteMessage(false); setWhiteFlash(true); window.setTimeout(() => { setWhiteFlash(false); setWhiteMessage(true); window.setTimeout(() => setWhiteMessage(false), 4200) }, 1000) }

  return <main onDragOver={(event) => { if (isFileDrag(event)) { event.preventDefault(); setFileDropActive(true) } }} onDragLeave={(event) => { if (isFileDrag(event)) setFileDropActive(false) }} onDrop={handleFileDrop}>
    <header className="topbar"><div className="brand"><img src={logo} alt="JH Artworks" /><h1>NC Combiner</h1></div><div className="header-actions"><span className="count">{sections.length} Abschnitte</span><button className="secondary white-mode-button" onClick={flashWhiteMode}>Whitemode</button><label className="download-format">Format<select value={selectedDownloadFormat} onChange={(event) => setDownloadFormat(event.target.value)}>{['din', 'nc', 'ngc', 'tap', 'txt'].map((format) => <option key={format} value={format}>.{format}</option>)}</select></label><button className="primary" onClick={download} disabled={!sections.length}>Datei herunterladen</button></div></header>
    {whiteFlash && <div className="white-flash" aria-hidden="true" />}
    {fileDropActive && <div className="file-drop-overlay" aria-hidden="true"><div>Dateien hier ablegen</div><span>DIN, NC, TAP oder TXT</span></div>}
    {whiteMessage && <div className="white-mode-message" role="status">Ich hoffe dass war dir hell genug. Only Pussys are using Whitemode</div>}
    <div className="layout">
      <aside className="sidebar">
        <section><h2>Verwaltung</h2><button className="secondary" onClick={() => setAdminOpen(true)}>Postprozessoren &amp; Aliase</button></section>
        <section><h2>Persönliche Bibliothek</h2><button className="secondary" onClick={() => setLibraryOpen(true)}>{account ? account.username + " · Bibliothek" : "Anmelden / Bibliothek"}</button>{(adminSession || account?.isAdmin) && <button className="secondary" onClick={() => setUserAdminOpen(true)}>Benutzerverwaltung</button>}</section>
        <section><div className="section-heading"><h2>NC-Programme</h2></div><label className="upload" htmlFor="nc-program-files">Dateien hinzuf&uuml;gen</label><input id="nc-program-files" ref={fileRef} className="file-input" type="file" accept=".din,.nc,.tap,.txt" multiple onChange={async (event) => { await addFiles(event.target.files); event.target.value = '' }} /></section>
        <section><h2>Werkzeugtabelle</h2><button className="secondary" onClick={() => toolRef.current.click()}>Tabelle hochladen</button><input ref={toolRef} type="file" accept=".csv,.tsv,.txt,.json" hidden onChange={async (event) => { try { const items = parseToolTable(await event.target.files[0].text(), event.target.files[0].name); setTools(items); } catch { alert('Werkzeugtabelle konnte nicht gelesen werden. Erwartet werden CSV, Text oder JSON.'); } }} />
          <p className="hint">{tools.length ? `${tools.length} Werkzeuge geladen` : 'CSV, TSV, Text oder JSON'}</p></section>
        <section><h2>Postprozessor</h2><select value={profileId} onChange={(event) => { setProfileId(event.target.value); setDownloadFormat('') }}>{profiles.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></section>
      </aside>
      <section className="workspace">
        <div className="workspace-body"><div className="editor-pane">
        <div className="workspace-head"><div><span className="eyebrow">MERGE-REIHENFOLGE</span><h2>Bearbeitungsabschnitte</h2></div></div>
        {!sections.length && <div className="empty"><div className="empty-icon">⌁</div><h2>Programme hinzufügen</h2><p>Lade deine DIN-Dateien hoch. Kopf und Programmende werden beim Merge automatisch nur einmal ausgegeben.</p><label className="primary empty-upload" htmlFor="nc-program-files">NC-Dateien w&auml;hlen</label></div>}
        <div className="cards">{sections.length > 0 && <div className="program-boundary program-start"><span>G-Code Anfang</span><small>Programmkopf</small></div>}{sections.map((section, index) => <React.Fragment key={section.id}><article className={`card ${section.enabled ? '' : 'disabled'}`} style={{ '--section-color': section.operations[0]?.color || '#527aa9' }} key={section.id} draggable onDragStart={() => setDragId(section.id)} onDragOver={(event) => event.preventDefault()} onDrop={() => { const from = sections.findIndex((item) => item.id === dragId); if (from !== index) move(from, index); setDragId(null) }}>
          <div className="card-head"><span className="drag" title="Zum Sortieren ziehen">&#8281;</span><span className="order">{String(index + 1).padStart(2, '0')}</span><input className="filename" value={section.filename} onChange={(event) => updateSection(section.id, { filename: event.target.value })} /><div className="header-operations">{section.operations.map((operation) => <div className="header-operation" key={operation.id}><span className="operation-name"><i style={{ backgroundColor: operation.color || '#80d99b' }} />({operation.name})</span><label className="tool-control"><span>Werkzeug T</span><div className="tool-inputs"><input type="number" min="0" step="1" inputMode="numeric" list="tool-options" placeholder="Nummer" value={operation.tool} onChange={(event) => updateOperation(section.id, operation.id, { tool: event.target.value })} />{tools.length > 0 && <select aria-label="Werkzeug aus Tabelle w&auml;hlen" value={tools.some((tool) => tool.number === operation.tool) ? operation.tool : ''} onChange={(event) => updateOperation(section.id, operation.id, { tool: event.target.value })}><option value="" disabled>Aus Tabelle w&auml;hlen</option>{tools.map((tool) => <option key={tool.number} value={tool.number}>T{tool.number}{tool.name ? ' \u2014 ' + tool.name : ''}</option>)}</select>}</div></label><label className="color-control" title="Operationsfarbe"><span>Farbe</span><input type="color" value={operation.color || '#80d99b'} onChange={(event) => updateOperation(section.id, operation.id, { color: event.target.value })} /></label></div>)}</div><label className="toggle"><input type="checkbox" checked={section.enabled} onChange={(event) => updateSection(section.id, { enabled: event.target.checked })} /><span /></label><button className="delete" onClick={() => setSections((old) => old.filter((item) => item.id !== section.id))} title="Abschnitt entfernen">&times;</button></div>
          <div className="settings"><div className="rate-group"><span>Vorschübe F</span>{section.feedValues.length ? section.feedValues.map((item) => <label key={item.original}>F{item.original}<input inputMode="decimal" value={item.value} onChange={(event) => updateSection(section.id, { feedValues: section.feedValues.map((entry) => entry.original === item.original ? { ...entry, value: event.target.value } : entry) })} /></label>) : <p className="hint">keine F-Werte</p>}</div><div className="rate-group"><span>Drehzahlen S</span>{section.speedValues.length ? section.speedValues.map((item) => <label key={item.original}>S{item.original}<input inputMode="decimal" value={item.value} onChange={(event) => updateSection(section.id, { speedValues: section.speedValues.map((entry) => entry.original === item.original ? { ...entry, value: event.target.value } : entry) })} /></label>) : <p className="hint">keine S-Werte</p>}</div><label>Nullpunkt<select value={section.offset} onChange={(event) => updateSection(section.id, { offset: event.target.value })}>{['G54','G55','G56','G57','G58','G59'].map((item) => <option key={item}>{item}</option>)}</select></label></div>

          {!section.operations.length && <p className="hint card-hint">Keine Operations-Kommentare gefunden.</p>}
        </article><PlaceholderBlocks placeholders={(section.placeholders || []).filter((item) => item.afterOperationId === '__section_end__')} onAdd={() => addPlaceholder(section.id, '__section_end__')} onChange={(placeholderId, updates) => updatePlaceholder(section.id, placeholderId, updates)} onRemove={(placeholderId) => removePlaceholder(section.id, placeholderId)} onMove={(fromId, toId) => movePlaceholder(section.id, '__section_end__', fromId, toId)} /></React.Fragment>)}{sections.length > 0 && <div className="program-boundary program-end"><span>G-Code Ende</span><small>Programmende</small></div>}</div></div><datalist id="tool-options">{tools.map((tool) => <option key={tool.number} value={tool.number} label={tool.name ? `T${tool.number} ? ${tool.name}` : `T${tool.number}`} />)}</datalist><aside className="preview-pane"><div className="preview-pane-head"><div><span className="eyebrow">LIVE</span><h2>G-Code-Vorschau</h2></div><div className="preview-controls"><div className="preview-mode-toggle"><button type="button" className={previewMode === 'graphic' ? 'active' : ''} onClick={() => setPreviewMode('graphic')}>Grafik</button><button type="button" className={previewMode === 'text' ? 'active' : ''} onClick={() => setPreviewMode('text')}>Text</button></div><button className="secondary" onClick={() => { setLibraryPreview(''); setPreviewOpen(true) }} disabled={!sections.length}>Vollbild</button></div></div>{previewMode === 'text' ? <TextCodePreview program={result} /> : <ToolpathPreview program={result} operationColors={operationColors} idle={!sections.length} />}</aside></div>
      </section>
    </div>
    {previewOpen && <div className="modal-backdrop" onMouseDown={() => setPreviewOpen(false)}><div className="modal preview-modal" onMouseDown={(event) => event.stopPropagation()}><div className="modal-head"><div><span className="eyebrow">KOMBINIERTE DATEI</span><h2>Vorschau</h2></div><button className="delete" onClick={() => setPreviewOpen(false)}>×</button></div><ToolpathPreview program={previewProgram} operationColors={operationColors} idle={!sections.length && !libraryPreview} /><pre>{previewProgram}</pre><div className="modal-actions"><button className="secondary" onClick={() => setPreviewOpen(false)}>Schließen</button><button className="primary" onClick={download}>Herunterladen</button></div></div></div>}
    {libraryOpen && <LibraryPanel account={account} setAccount={setAccount} program={result} tools={tools} setTools={setTools} onPreview={(content) => { setLibraryPreview(content); setPreviewOpen(true); setLibraryOpen(false) }} onClose={() => setLibraryOpen(false)} />}
    {userAdminOpen && <UserAdminPanel onClose={() => setUserAdminOpen(false)} />}
    {adminOpen && <AdminPanel onClose={() => setAdminOpen(false)} onSessionChange={setAdminSession} onSaved={() => { fetch('/api/profiles').then((r) => r.json()).then((items) => { setProfiles(items); setProfileId(String(items[0]?.id || '')) }); fetch('/api/aliases').then((r) => r.json()).then(setAliases) }} />}
  </main>
}

createRoot(document.getElementById('root')).render(<App />)
function OperationCard({ operation, tools, onUpdate }) {
  return <div className="operation-card"><div className="operation-card-head"><span className="operation-name"><i style={{ backgroundColor: operation.color || '#80d99b' }} />({operation.name})</span><div className="operation-actions"><label className="tool-control"><span>Werkzeug T</span><div className="tool-inputs"><input type="number" min="0" step="1" inputMode="numeric" list="tool-options" placeholder="Nummer" value={operation.tool} onChange={(event) => onUpdate({ tool: event.target.value })} />{tools.length > 0 && <select aria-label="Werkzeug aus Tabelle w&auml;hlen" value={tools.some((tool) => tool.number === operation.tool) ? operation.tool : ''} onChange={(event) => onUpdate({ tool: event.target.value })}><option value="" disabled>Aus Tabelle w&auml;hlen</option>{tools.map((tool) => <option key={tool.number} value={tool.number}>T{tool.number}{tool.name ? ' \u2014 ' + tool.name : ''}</option>)}</select>}</div></label><label className="color-control" title="Operationsfarbe"><span>Farbe</span><input type="color" value={operation.color || '#80d99b'} onChange={(event) => onUpdate({ color: event.target.value })} /></label></div></div></div>
}

function TextCodePreview({ program }) {
  const lineRefs = useRef(new Map())
  const lines = useMemo(() => program.split('\n'), [program])
  const operations = useMemo(() => lines.map((line, lineIndex) => ({ line: line.trim(), lineIndex })).filter(({ line }) => /^\([^)]{1,120}\)$/.test(line) && !/^\(T\d+\b/i.test(line) && !/^\(Combined NC Code\b/i.test(line) && !/^\(NC COMBINED\b/i.test(line)).map(({ line, lineIndex }) => ({ name: line.slice(1, -1), lineIndex })), [lines])
  const jumpTo = (lineIndex) => lineRefs.current.get(lineIndex)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  return <div className="text-preview-layout"><pre className="inline-code-preview">{lines.map((line, lineIndex) => <span className="code-line" data-line={lineIndex} ref={(node) => { if (node) lineRefs.current.set(lineIndex, node) }} key={lineIndex}>{line || ' '} {'\n'}</span>)}</pre><aside className="operation-jump-list"><span>Operationen</span>{operations.length ? operations.map((operation, index) => <button type="button" key={operation.lineIndex} onClick={() => jumpTo(operation.lineIndex)} title={'Zu ' + operation.name + ' springen'}>{String(index + 1).padStart(2, '0')} {operation.name}</button>) : <p>Keine Operationen</p>}</aside></div>
}

function PlaceholderBlocks({ placeholders, onAdd, onChange, onRemove, onMove }) {
  const [dragId, setDragId] = useState(null)
  return <div className="placeholder-list">{placeholders.map((placeholder) => <PlaceholderBlock key={placeholder.id} placeholder={placeholder} onChange={(updates) => onChange(placeholder.id, updates)} onDelete={() => onRemove(placeholder.id)} onDragStart={() => setDragId(placeholder.id)} onDrop={() => { if (dragId) onMove(dragId, placeholder.id); setDragId(null) }} />)}<button type="button" className="placeholder-add" onClick={onAdd}><b>+</b><span>Weiteren Zwischenblock einf&uuml;gen</span></button></div>
}

function PlaceholderBlock({ placeholder, onChange, onDelete, onDragStart, onDrop }) {
  const [open, setOpen] = useState(false)
  const fileRef = useRef(null)
  const update = (updates) => onChange({ ...placeholder, ...updates })
  const readNcFile = async (event) => {
    const file = event.target.files?.[0]
    if (!file) return
    const raw = await file.text()
    const content = findProgramEdges(raw).body || normalise(raw).trim()
    update({ mode: 'file', content, filename: file.name })
    setOpen(true)
    event.target.value = ''
  }
  const label = placeholder.mode === 'file' && placeholder.filename ? 'NC-Datei: ' + placeholder.filename : 'Zwischenblock bearbeiten'
  return <div className={'placeholder-slot ' + (open ? 'is-open' : '')} draggable onDragStart={onDragStart} onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
    <div className="placeholder-row"><span className="placeholder-drag" title="Zum Sortieren ziehen">&#8281;</span><button type="button" className="placeholder-add" onClick={() => setOpen((value) => !value)} aria-expanded={open}><span>{label}</span></button><button type="button" className="delete-text" onClick={onDelete} title="Zwischenblock entfernen">Entfernen</button></div>
    {open && <div className="placeholder-block"><span className="placeholder-title">Zwischenblock</span><select value={placeholder.mode} onChange={(event) => update({ mode: event.target.value })}><option value="blank">Leerzeilen</option><option value="dwell">Wartezeit</option><option value="m2">M2 Pause</option><option value="custom">Eigener NC-Befehl</option><option value="file">NC-Datei einf&uuml;gen</option></select>{placeholder.mode === 'blank' && <label>Leerzeilen<input type="number" min="1" max="50" value={placeholder.lines} onChange={(event) => update({ lines: event.target.value })} /></label>}{placeholder.mode === 'dwell' && <label>Wartezeit<input inputMode="decimal" value={placeholder.value} onChange={(event) => update({ value: event.target.value })} /></label>}{placeholder.mode === 'custom' && <label>NC-Befehl<textarea value={placeholder.command} placeholder="z. B. M0" onChange={(event) => update({ command: event.target.value })} /></label>}{placeholder.mode === 'file' && <div className="placeholder-file"><input ref={fileRef} type="file" accept=".din,.nc,.tap,.txt" hidden onChange={readNcFile} /><button type="button" className="secondary" onClick={() => fileRef.current?.click()}>NC-Datei w&auml;hlen</button><span>{placeholder.filename || 'Noch keine NC-Datei ausgew&auml;hlt.'}</span>{placeholder.filename && <button type="button" className="delete-text" onClick={() => update({ content: '', filename: '' })}>Entfernen</button>}</div>}</div>}
  </div>
}

function AdminPanel({ onClose, onSaved, onSessionChange }) { const blankProfile = () => ({ id: null, name: '', header: DEFAULT_HEADER, footer: DEFAULT_FOOTER, dwell_template: 'G4 P{seconds}' }); const blankAlias = () => ({ id: null, alias: '', replacement: '', description: '' }); const [me, setMe] = useState(null); const [login, setLogin] = useState({ username: 'admin', password: '' }); const [profiles, setProfiles] = useState([]); const [aliases, setAliases] = useState([]); const [profileForm, setProfileForm] = useState(blankProfile); const [aliasForm, setAliasForm] = useState(blankAlias); const [error, setError] = useState(''); async function load() { const [p, a] = await Promise.all([fetch('/api/profiles').then((r) => r.json()), fetch('/api/aliases').then((r) => r.json())]); setProfiles(p); setAliases(a) } useEffect(() => { load().catch(() => {}); fetch('/api/admin/me').then((r) => r.ok ? r.json() : null).then(setMe) }, []); async function logIn(event) { event.preventDefault(); setError(''); const r = await fetch('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(login) }); const body = await r.json(); if (!r.ok) return setError(body.error); setMe(body); onSessionChange?.(true); await load() } async function save(kind, data) { setError(''); const r = await fetch(`/api/admin/${kind}${data.id ? `/${data.id}` : ''}`, { method: data.id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }); const body = r.status === 204 ? null : await r.json(); if (!r.ok) return setError(body.error || 'Speichern fehlgeschlagen.'); await load(); onSaved(); if (kind === 'profiles') setProfileForm({ ...body }); else setAliasForm({ ...body }) } async function remove(kind, data) { if (!data.id || !confirm('Eintrag wirklich löschen?')) return; const r = await fetch(`/api/admin/${kind}/${data.id}`, { method: 'DELETE' }); if (!r.ok) { const body = await r.json(); return setError(body.error) } await load(); onSaved(); if (kind === 'profiles') setProfileForm(blankProfile()); else setAliasForm(blankAlias()) } if (!me) return <div className="modal-backdrop"><form className="modal admin-login" onSubmit={logIn}><div className="modal-head"><div><span className="eyebrow">GESCHÜTZTER BEREICH</span><h2>Administration</h2></div><button type="button" className="delete" onClick={onClose}>×</button></div><div className="admin-body"><p className="hint">Der Merge-Bereich bleibt ohne Anmeldung nutzbar.</p><label>Benutzername<input value={login.username} onChange={(e) => setLogin({ ...login, username: e.target.value })} /></label><label>Passwort<input type="password" value={login.password} onChange={(e) => setLogin({ ...login, password: e.target.value })} autoFocus /></label>{error && <p className="error">{error}</p>}</div><div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>Abbrechen</button><button className="primary">Anmelden</button></div></form></div>; return <div className="modal-backdrop"><div className="modal admin-modal"><div className="modal-head"><div><span className="eyebrow">ANGEMELDET ALS {me.username}</span><h2>Postprozessoren &amp; Aliase</h2></div><button className="delete" onClick={onClose}>×</button></div><div className="admin-body admin-columns"><section><h3>Postprozessoren</h3><select value={profileForm.id || ''} onChange={(e) => setProfileForm(e.target.value ? { ...profiles.find((item) => String(item.id) === e.target.value) } : blankProfile())}><option value="">Neues Profil</option>{profiles.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><label>Name<input value={profileForm.name} onChange={(e) => setProfileForm({ ...profileForm, name: e.target.value })} /></label><label>Programmkopf<textarea value={profileForm.header} onChange={(e) => setProfileForm({ ...profileForm, header: e.target.value })} /></label><label>Programmende<textarea value={profileForm.footer} onChange={(e) => setProfileForm({ ...profileForm, footer: e.target.value })} /></label><label>Wartezeit-Vorlage<input value={profileForm.dwell_template || 'G4 P{seconds}'} onChange={(e) => setProfileForm({ ...profileForm, dwell_template: e.target.value })} placeholder="G4 P{seconds}" /></label><p className="hint">{`{seconds}`} wird durch die Wartezeit ersetzt.</p><div className="admin-actions"><button className="primary" onClick={() => save('profiles', profileForm)}>Speichern</button><button className="secondary" onClick={() => setProfileForm(blankProfile())}>Neu</button>{profileForm.id && <button className="delete-text" onClick={() => remove('profiles', profileForm)}>Löschen</button>}</div></section><section><h3>NC-Aliase</h3><p className="hint">Wortgenaue Ersetzung beim Export, z. B. ein maschinenspezifisches Kürzel.</p><select value={aliasForm.id || ''} onChange={(e) => setAliasForm(e.target.value ? { ...aliases.find((item) => String(item.id) === e.target.value) } : blankAlias())}><option value="">Neuer Alias</option>{aliases.map((item) => <option key={item.id} value={item.id}>{item.alias} → {item.replacement}</option>)}</select><label>Alias<input value={aliasForm.alias} onChange={(e) => setAliasForm({ ...aliasForm, alias: e.target.value })} /></label><label>Ersetzung<input value={aliasForm.replacement} onChange={(e) => setAliasForm({ ...aliasForm, replacement: e.target.value })} /></label><label>Beschreibung<input value={aliasForm.description} onChange={(e) => setAliasForm({ ...aliasForm, description: e.target.value })} /></label><div className="admin-actions"><button className="primary" onClick={() => save('aliases', aliasForm)}>Speichern</button><button className="secondary" onClick={() => setAliasForm(blankAlias())}>Neu</button>{aliasForm.id && <button className="delete-text" onClick={() => remove('aliases', aliasForm)}>Löschen</button>}</div></section></div>{error && <p className="error admin-error">{error}</p>}<div className="modal-actions"><button className="secondary" onClick={async () => { await fetch('/api/admin/logout', { method: 'POST' }); setMe(null); onSessionChange?.(false) }}>Abmelden</button><button className="primary" onClick={onClose}>Fertig</button></div></div></div> }

function LibraryPanel({ account, setAccount, program, tools, setTools, onPreview, onClose }) { const [login, setLogin] = useState({ username: '', password: '' }); const [programs, setPrograms] = useState([]); const [toolLists, setToolLists] = useState([]); const [programName, setProgramName] = useState('Kombiniertes Programm'); const [toolName, setToolName] = useState('Werkzeugliste'); const [error, setError] = useState(''); async function load() { const [p, t] = await Promise.all([fetch('/api/library/programs').then((r) => r.ok ? r.json() : []), fetch('/api/library/tools').then((r) => r.ok ? r.json() : [])]); setPrograms(p); setToolLists(t) } useEffect(() => { if (account) load().catch(() => setError('Bibliothek konnte nicht geladen werden.')) }, [account]); async function signIn(e) { e.preventDefault(); setError(''); const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(login) }); const body = await r.json(); if (!r.ok) return setError(body.error); setAccount(body) } async function save(kind) { setError(''); const body = kind === 'programs' ? { name: programName, content: program } : { name: toolName, tools }; const r = await fetch('/api/library/' + kind, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); if (!r.ok) return setError((await r.json()).error || 'Speichern fehlgeschlagen.'); await load() } async function remove(kind, id) { if (!confirm('Eintrag wirklich löschen?')) return; await fetch('/api/library/' + kind + '/' + id, { method: 'DELETE' }); await load() } function download(name, content) { const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' })); const a = document.createElement('a'); a.href = url; a.download = name.endsWith('.din') ? name : name + '.din'; a.click(); URL.revokeObjectURL(url) } if (!account) return <div className="modal-backdrop"><form className="modal admin-login" onSubmit={signIn}><div className="modal-head"><div><span className="eyebrow">OPTIONALE ANMELDUNG</span><h2>Persönliche Bibliothek</h2></div><button type="button" className="delete" onClick={onClose}>×</button></div><div className="admin-body"><p className="hint">Der NC-Combiner ist weiterhin ohne Konto nutzbar. Ein Konto wird nur zum Speichern deiner G-Codes und Werkzeuglisten benötigt.</p><label>Benutzername<input value={login.username} onChange={(e) => setLogin({ ...login, username: e.target.value })} autoFocus /></label><label>Passwort<input type="password" value={login.password} onChange={(e) => setLogin({ ...login, password: e.target.value })} /></label>{error && <p className="error">{error}</p>}</div><div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>Abbrechen</button><button className="primary">Anmelden</button></div></form></div>; return <div className="modal-backdrop"><div className="modal library-modal"><div className="modal-head"><div><span className="eyebrow">BIBLIOTHEK VON {account.username}</span><h2>G-Codes &amp; Werkzeuglisten</h2></div><button className="delete" onClick={onClose}>×</button></div><div className="admin-body library-columns"><section><h3>Aktuellen G-Code speichern</h3><label>Name<input value={programName} onChange={(e) => setProgramName(e.target.value)} /></label><button className="primary" onClick={() => save('programs')}>In Bibliothek speichern</button><div className="library-list">{programs.map((item) => <div className="library-item" key={item.id}><strong>{item.name}</strong><div><button className="secondary" onClick={() => onPreview(item.content)}>Vorschau</button><button className="secondary" onClick={() => download(item.name, item.content)}>DIN</button><button className="delete-text" onClick={() => remove('programs', item.id)}>Löschen</button></div></div>)}{!programs.length && <p className="hint">Noch keine gespeicherten Programme.</p>}</div></section><section><h3>Werkzeugliste speichern</h3><label>Name<input value={toolName} onChange={(e) => setToolName(e.target.value)} /></label><button className="primary" onClick={() => save('tools')} disabled={!tools.length}>Aktuelle Liste speichern</button><div className="library-list">{toolLists.map((item) => <div className="library-item" key={item.id}><strong>{item.name}</strong><div><button className="secondary" onClick={() => { setTools(item.tools); onClose() }}>Laden</button><button className="delete-text" onClick={() => remove('tools', item.id)}>Löschen</button></div></div>)}{!toolLists.length && <p className="hint">Noch keine gespeicherten Werkzeuglisten.</p>}</div></section></div>{error && <p className="error admin-error">{error}</p>}<div className="modal-actions"><button className="secondary" onClick={async () => { await fetch('/api/auth/logout', { method: 'POST' }); setAccount(null); onClose() }}>Abmelden</button><button className="primary" onClick={onClose}>Fertig</button></div></div></div> }
function UserAdminPanel({ onClose }) { const [users, setUsers] = useState([]); const [form, setForm] = useState({ username: '', password: '', isAdmin: false }); const [error, setError] = useState(''); async function load() { const r = await fetch('/api/manage/users'); if (!r.ok) return setError('Bitte zuerst über Verwaltung als Admin anmelden.'); setUsers(await r.json()) } useEffect(() => { load().catch(() => setError('Benutzer konnten nicht geladen werden.')) }, []); async function create(e) { e.preventDefault(); setError(''); const r = await fetch('/api/manage/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) }); if (!r.ok) return setError((await r.json()).error || 'Benutzer konnte nicht angelegt werden.'); setForm({ username: '', password: '', isAdmin: false }); await load() } async function role(item) { const r = await fetch('/api/manage/users/' + item.id + '/role', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ isAdmin: !item.is_admin }) }); if (!r.ok) return setError((await r.json()).error); await load() } async function reset(item) { const password = prompt('Neues Passwort für ' + item.username + ' (mindestens 8 Zeichen):'); if (!password) return; const r = await fetch('/api/manage/users/' + item.id + '/password', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) }); if (!r.ok) return setError((await r.json()).error); alert('Passwort wurde zurückgesetzt.') } async function remove(item) { if (!confirm(item.username + ' wirklich löschen?')) return; const r = await fetch('/api/manage/users/' + item.id, { method: 'DELETE' }); if (!r.ok) return setError((await r.json()).error); await load() } return <div className="modal-backdrop"><div className="modal user-modal"><div className="modal-head"><div><span className="eyebrow">ADMINISTRATION</span><h2>Benutzerverwaltung</h2></div><button className="delete" onClick={onClose}>×</button></div><div className="admin-body user-columns"><form className="user-create" onSubmit={create}><h3>Benutzer anlegen</h3><label>Benutzername<input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} /></label><label>Startpasswort<input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></label><label className="check-label"><input type="checkbox" checked={form.isAdmin} onChange={(e) => setForm({ ...form, isAdmin: e.target.checked })} /> Als Admin anlegen</label><button className="primary">Benutzer anlegen</button></form><section><h3>Vorhandene Benutzer</h3><div className="user-list">{users.map((item) => <div className="user-item" key={item.id}><div><strong>{item.username}</strong><span>{item.is_admin ? 'Admin' : 'Benutzer'}</span></div><div><button className="secondary" onClick={() => reset(item)}>Passwort</button><button className="secondary" onClick={() => role(item)}>{item.is_admin ? 'Admin entfernen' : 'Zum Admin machen'}</button><button className="delete-text" onClick={() => remove(item)}>Löschen</button></div></div>)}</div></section></div>{error && <p className="error admin-error">{error}</p>}<div className="modal-actions"><button className="primary" onClick={onClose}>Fertig</button></div></div></div> }
