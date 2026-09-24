'use client'
import { useEffect, useState } from 'react'
import { useNavigate } from '@/lib/router'
import {
  ArrowLeft,
  BarChart3,
  Briefcase,
  Building2,
  CalendarDays,
  Camera,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  Clock3,
  FileText,
  Map,
  MapPin,
  Maximize2,
  Navigation,
  Phone,
  Play,
  Plus,
  Route,
  Square,
  Wifi,
} from 'lucide-react'

type Stop = {
  id: number
  name: string
  time: string
  end?: string
  status: 'done' | 'current' | 'upcoming'
  note?: string
  address?: string
}
type Log = {
  time: string
  type: 'Check In' | 'Check Out' | 'Visit' | 'Note'
  location: string
  note: string
  photo: string
}

const clients = [
  'HealthPlus',
  'City Pharmacy',
  'Galaxy Medical',
  'Chughtai Pharma',
  'Al-Fatah Pharmacy',
  'MedCare Store',
  'LifeLine Pharmacy',
  'Shifa Medical Store',
  'Noor Pharmacy',
]
const times = [
  '11:00 AM',
  '12:00 PM',
  '1:00 PM',
  '2:00 PM',
  '2:30 PM',
  '3:00 PM',
  '3:30 PM',
  '4:00 PM',
  '4:30 PM',
  '5:00 PM',
]
const initialStops: Stop[] = [
  { id: 1, name: 'Al-Fatah Pharmacy', time: '9:15 AM', end: '9:45 AM', status: 'done' },
  { id: 2, name: 'MedCare Store', time: '10:10 AM', end: '10:40 AM', status: 'done' },
  { id: 3, name: 'LifeLine Pharmacy', time: '11:30 AM', status: 'done', note: '(Next Visit)' },
  {
    id: 4,
    name: 'HealthPlus',
    time: '1:00 PM',
    status: 'current',
    address: '12-C, Commercial Area, Johar Town, Lahore',
  },
  {
    id: 5,
    name: 'City Pharmacy',
    time: '2:30 PM',
    status: 'upcoming',
    address: 'Main Blvd, Johar Town, Lahore',
  },
  {
    id: 6,
    name: 'Galaxy Medical',
    time: '3:30 PM',
    status: 'upcoming',
    address: 'Block G, Johar Town, Lahore',
  },
  {
    id: 7,
    name: 'Chughtai Pharma',
    time: '4:30 PM',
    status: 'upcoming',
    address: 'Wapda Town Roundabout, Lahore',
  },
  {
    id: 8,
    name: 'Return to Office',
    time: '5:30 PM',
    status: 'upcoming',
    note: 'End of Day',
    address: 'Bhatti Traders, Model Town, Lahore',
  },
]
const initialLog: Log[] = [
  {
    time: '9:00 AM',
    type: 'Check In',
    location: 'Johar Town, Lahore',
    note: 'Started field work',
    photo: '#B76E52',
  },
  {
    time: '9:15 AM',
    type: 'Visit',
    location: 'Al-Fatah Pharmacy',
    note: 'Product discussion',
    photo: '#7C5B3E',
  },
  {
    time: '10:10 AM',
    type: 'Visit',
    location: 'MedCare Store',
    note: 'Order follow up',
    photo: '#4F6A73',
  },
]
const pad = (n: number) => String(n).padStart(2, '0')
const nowLabel = (sec: number) => {
  const total = 9 * 3600 + sec
  const h = Math.floor(total / 3600) % 24,
    m = Math.floor((total % 3600) / 60)
  const hh = ((h + 11) % 12) + 1
  return `${hh}:${pad(m)} ${h >= 12 ? 'PM' : 'AM'}`
}
// pin coordinates on the 360x220 map for stops 1..8 (percentages)
const pins: [number, number][] = [
  [19, 45],
  [36, 32],
  [55, 45],
  [80, 45],
  [72, 60],
  [89, 72],
  [57, 78],
  [72, 86],
]

export function AttendanceEntry() {
  const navigate = useNavigate()
  const [sec, setSec] = useState(3 * 3600 + 24 * 60 + 17),
    [checkedIn, setCheckedIn] = useState(true),
    [note, setNote] = useState(
      'Meeting with Pharmacia client. Discussed new product line. Next visit at 2 PM.',
    ),
    [photo, setPhoto] = useState(false)
  const [stops, setStops] = useState(initialStops),
    [log, setLog] = useState(initialLog),
    [client, setClient] = useState(''),
    [time, setTime] = useState(''),
    [notesAdded, setNotesAdded] = useState(1),
    [toast, setToast] = useState('')
  useEffect(() => {
    if (!checkedIn) return
    const t = setInterval(() => setSec((s) => s + 1), 1000)
    return () => clearInterval(t)
  }, [checkedIn])
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(''), 2600)
    return () => clearTimeout(t)
  }, [toast])
  const h = Math.floor(sec / 3600),
    m = Math.floor((sec % 3600) / 60),
    s = sec % 60
  const done = stops.filter((x) => x.status === 'done').length
  const current = stops.find((x) => x.status === 'current')
  const pct = Math.round((done / stops.length) * 100)
  const ring = 2 * Math.PI * 54
  const checkOut = () => {
    if (!checkedIn) return
    setCheckedIn(false)
    setLog((l) => [
      ...l,
      {
        time: nowLabel(sec),
        type: 'Check Out',
        location: 'Johar Town, Lahore',
        note: `End of day · ${h}h ${m}m worked`,
        photo: '#5B7A5E',
      },
    ])
    setToast('Checked out. Have a good evening!')
  }
  const saveNote = () => {
    if (!note.trim()) return
    setLog((l) => [
      ...l,
      {
        time: nowLabel(sec),
        type: 'Note',
        location: current?.name ?? 'Field',
        note: note.trim(),
        photo: photo ? '#8A6D4B' : '',
      },
    ])
    setNotesAdded((n) => n + 1)
    setNote('')
    setPhoto(false)
    setToast("Note saved to today's log")
  }
  const addStop = () => {
    if (!client || !time) return
    setStops((p) => {
      const idx = p.findIndex((x) => x.name === 'Return to Office')
      const ns: Stop = {
        id: p.length + 1,
        name: client,
        time,
        status: 'upcoming',
        address: `${client}, Lahore`,
      }
      const next = idx >= 0 ? [...p.slice(0, idx), ns, ...p.slice(idx)] : [...p, ns]
      return next.map((x, i) => ({ ...x, id: i + 1 }))
    })
    setClient('')
    setTime('')
    setToast(`${client} added to today's route`)
  }
  const startVisit = (id: number) => {
    setStops((p) => {
      const i = p.findIndex((x) => x.id === id)
      return p.map((x, k) =>
        k === i
          ? { ...x, status: 'done', end: nowLabel(sec) }
          : k === i + 1
            ? { ...x, status: 'current' }
            : x,
      )
    })
    const st = stops.find((x) => x.id === id)
    if (st)
      setLog((l) => [
        ...l,
        { time: nowLabel(sec), type: 'Visit', location: st.name, note: 'Visit started', photo: '' },
      ])
    setToast(`Visit to ${stops.find((x) => x.id === id)?.name} started`)
  }
  return (
    <div className="ae-page">
      <div className="ae-top">
        <button
          type="button"
          className="ae-back"
          aria-label="Back to attendance list"
          onClick={() => navigate('/hr/attendance')}
        >
          <ArrowLeft />
        </button>
        <nav className="ae-crumb">
          <span>People</span>
          <i />
          <span>Visits</span>
          <i />
          <span>Impact</span>
        </nav>
        <div className="ae-date">
          <CalendarDays />
          <span>Mon, 15 Sep 2026</span>
        </div>
        <div className="ae-daynav">
          <button type="button" aria-label="Previous day">
            <ChevronLeft />
          </button>
          <button type="button" aria-label="Next day">
            <ChevronRight />
          </button>
        </div>
        <div className="ae-user">
          <span>AS</span>
          <div>
            <b>Ali Shah</b>
            <small>Field Executive</small>
          </div>
          <ChevronDown />
        </div>
      </div>
      {toast && (
        <div className="ae-toast" role="status">
          <CheckCircle2 />
          {toast}
        </div>
      )}
      <div className="ae-grid">
        <section className="ae-card ae-attend">
          <div className="ae-card-head">
            <div>
              <h1>Attendance</h1>
              <p>Check in, track your time and manage your daily route.</p>
            </div>
            <span className={`ae-state ${checkedIn ? 'on' : ''}`}>
              <i />
              {checkedIn ? 'Currently Checked In' : 'Checked Out'}
            </span>
          </div>
          <div className="ae-timer">
            <div className="ae-clock">
              <div className="ae-digits">
                <span>
                  <b>{pad(h)}</b>
                  <small>Hours</small>
                </span>
                <em>:</em>
                <span>
                  <b>{pad(m)}</b>
                  <small>Minutes</small>
                </span>
                <em>:</em>
                <span>
                  <b>{pad(s)}</b>
                  <small>Seconds</small>
                </span>
              </div>
              <p>You checked in at 9:00 AM</p>
            </div>
            <div className="ae-ring">
              <svg viewBox="0 0 120 120" aria-hidden="true">
                <circle cx="60" cy="60" r="54" fill="none" stroke="#DCEFE3" strokeWidth="7" />
                <circle
                  cx="60"
                  cy="60"
                  r="54"
                  fill="none"
                  stroke="#12A64C"
                  strokeWidth="7"
                  strokeLinecap="round"
                  strokeDasharray={ring}
                  strokeDashoffset={ring * (1 - Math.min(1, sec / (9 * 3600)))}
                  transform="rotate(-90 60 60)"
                />
              </svg>
              <div>
                <Briefcase />
                <b>
                  {h}h {m}m
                </b>
                <small>Working Today</small>
              </div>
            </div>
          </div>
          <div className="ae-actions">
            <button
              type="button"
              className="ae-big in"
              disabled={checkedIn}
              onClick={() => {
                setCheckedIn(true)
                setToast('Checked in')
              }}
            >
              <span>
                <Play />
              </span>
              <div>
                <b>Check In</b>
                <small>{checkedIn ? 'Already checked in at 9:00 AM' : 'Start your day'}</small>
              </div>
            </button>
            <button type="button" className="ae-big out" disabled={!checkedIn} onClick={checkOut}>
              <span>
                <Square />
              </span>
              <div>
                <b>Check Out</b>
                <small>{checkedIn ? 'End your day' : `Checked out at ${nowLabel(sec)}`}</small>
              </div>
            </button>
          </div>
          <h3 className="ae-h3">
            <FileText /> Add a Note
          </h3>
          <div className="ae-note">
            <textarea
              aria-label="Note"
              maxLength={500}
              rows={3}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Write a note about your visit or day..."
            />
            <small>{note.length}/500</small>
          </div>
          <div className="ae-note-actions">
            <button
              type="button"
              className={`ae-btn soft ${photo ? 'active' : ''}`}
              onClick={() => setPhoto((p) => !p)}
            >
              <Camera /> {photo ? 'Photo attached' : 'Attach Photo (Optional)'}
            </button>
            <button
              type="button"
              className="ae-btn solid"
              onClick={saveNote}
              disabled={!note.trim()}
            >
              Save Note
            </button>
          </div>
          <div className="ae-addroute">
            <div className="ae-addroute-head">
              <span>
                <MapPin />
              </span>
              <div>
                <b>Add to Today's Route</b>
                <small>Quickly add a new visit to your route.</small>
              </div>
            </div>
            <div className="ae-addroute-form">
              <label>
                Select Client / Location
                <span className="ae-select">
                  <select
                    aria-label="Client"
                    value={client}
                    onChange={(e) => setClient(e.target.value)}
                  >
                    <option value="">Search or select client</option>
                    {clients.map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                  <ChevronDown />
                </span>
              </label>
              <label>
                Preferred Time
                <span className="ae-select">
                  <Clock3 />
                  <select
                    aria-label="Preferred time"
                    value={time}
                    onChange={(e) => setTime(e.target.value)}
                  >
                    <option value="">Select time</option>
                    {times.map((t) => (
                      <option key={t}>{t}</option>
                    ))}
                  </select>
                  <ChevronDown />
                </span>
              </label>
              <button
                type="button"
                className="ae-btn mint"
                onClick={addStop}
                disabled={!client || !time}
              >
                <Plus /> Add Stop
              </button>
            </div>
          </div>
        </section>
        <section className="ae-card ae-route">
          <div className="ae-card-head">
            <div>
              <h2>
                <Route /> Today's Route
              </h2>
              <p>
                {done} of {stops.length} stops completed <i />{' '}
                {done === stops.length ? 'All done!' : 'Keep going!'}
              </p>
            </div>
            <button type="button" className="ae-btn soft">
              <Map /> View Full Map
            </button>
          </div>
          <div className="ae-route-body">
            <ol className="ae-stops">
              {stops.map((st) => (
                <li key={st.id} className={st.status}>
                  <span className="ae-tick">
                    {st.status === 'done' ? (
                      <Check />
                    ) : st.status === 'current' ? (
                      <CircleDot />
                    ) : null}
                  </span>
                  <span className="ae-num">{st.id}</span>
                  <div>
                    <b>{st.name}</b>
                    <small>
                      {st.time}
                      {st.end ? ` – ${st.end}` : ''}
                    </small>
                    <em>
                      {st.status === 'done' ? (
                        <>Completed{st.note && <span> · {st.note}</span>}</>
                      ) : st.status === 'current' ? (
                        'Upcoming'
                      ) : (
                        (st.note ?? 'Upcoming')
                      )}
                    </em>
                  </div>
                  {st.status === 'current' && (
                    <button
                      type="button"
                      className="ae-btn solid sm"
                      onClick={() => startVisit(st.id)}
                    >
                      <Navigation /> Start Visit
                    </button>
                  )}
                </li>
              ))}
            </ol>
            <div className="ae-route-right">
              <div className="ae-panel">
                <div className="ae-panel-head">
                  <h3>
                    <Map /> Today's Route Map
                  </h3>
                  <button type="button" className="ae-icon" aria-label="Expand map">
                    <Maximize2 />
                  </button>
                </div>
                <div className="ae-map" role="img" aria-label="Route map with numbered stops">
                  <svg viewBox="0 0 360 220" preserveAspectRatio="none">
                    <defs>
                      <pattern id="ae-grid" width="22" height="22" patternUnits="userSpaceOnUse">
                        <path d="M22 0H0V22" fill="none" stroke="#DCE6EE" />
                      </pattern>
                    </defs>
                    <rect width="360" height="220" fill="#EEF3F7" />
                    <rect width="360" height="220" fill="url(#ae-grid)" />
                    <path
                      d="M0 70 H360 M0 150 H360 M80 0 V220 M190 0 V220 M270 0 V220"
                      stroke="#fff"
                      strokeWidth="7"
                    />
                    <path
                      d="M0 70 H360 M0 150 H360 M80 0 V220 M190 0 V220 M270 0 V220"
                      stroke="#D5DFE8"
                    />
                    <path
                      d="M46 130 L68 99"
                      stroke="#2F7CF6"
                      strokeWidth="3"
                      strokeLinecap="round"
                    />
                    <path
                      d="M68 99 L130 70 L198 99 L288 99"
                      fill="none"
                      stroke="#12A64C"
                      strokeWidth="3.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                    <path
                      d="M288 99 L259 132 L320 158 L205 172 L259 189"
                      fill="none"
                      stroke="#9AA8B6"
                      strokeWidth="2.5"
                      strokeDasharray="6 5"
                      strokeLinecap="round"
                    />
                  </svg>
                  {stops.slice(0, 8).map((st, i) => (
                    <span
                      key={st.id}
                      className={`ae-pin ${st.status}`}
                      style={{ left: `${pins[i][0]}%`, top: `${pins[i][1]}%` }}
                    >
                      {st.id}
                    </span>
                  ))}
                  <span className="ae-me" style={{ left: '13%', top: '60%' }}>
                    <i />
                    Current Location
                  </span>
                  <span className="ae-maplabel" style={{ left: '13%', top: '75%' }}>
                    Johar Town
                  </span>
                </div>
                <div className="ae-legend">
                  <span>
                    <i className="done" />
                    Completed
                  </span>
                  <span>
                    <i className="current" />
                    Current
                  </span>
                  <span>
                    <i className="upcoming" />
                    Upcoming
                  </span>
                  <span>
                    <i className="planned" />
                    Planned
                  </span>
                  <span>
                    <i className="me" />
                    My Location
                  </span>
                </div>
              </div>
              <div className="ae-panel">
                <div className="ae-panel-head">
                  <h3>Next Stop Details</h3>
                  <button type="button" className="ae-link">
                    Edit
                  </button>
                </div>
                {current ? (
                  <div className="ae-next">
                    <span className="ae-next-icon">
                      <Building2 />
                    </span>
                    <div>
                      <b>{current.name}</b>
                      <small>{current.address}</small>
                    </div>
                    <button type="button" className="ae-btn soft sm">
                      <Navigation /> Get Directions
                    </button>
                    <div className="ae-next-time">
                      <Clock3 />
                      {current.time} <span>(in 1h 36m)</span>
                    </div>
                    <button type="button" className="ae-btn soft sm">
                      <Phone /> Call
                    </button>
                  </div>
                ) : (
                  <div className="ae-empty">All stops completed for today.</div>
                )}
              </div>
            </div>
          </div>
        </section>
        <section className="ae-card ae-log">
          <div className="ae-card-head">
            <h2>
              <CalendarDays /> Today's Attendance Log
            </h2>
            <button type="button" className="ae-link" onClick={() => navigate('/hr/attendance')}>
              View All
            </button>
          </div>
          <div className="ae-table-wrap">
            <table className="ae-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Type</th>
                  <th>Location</th>
                  <th>Note</th>
                  <th>Photo</th>
                </tr>
              </thead>
              <tbody>
                {log.map((r, i) => (
                  <tr key={i}>
                    <td>{r.time}</td>
                    <td>
                      <span className={`ae-type ${r.type.replace(' ', '').toLowerCase()}`}>
                        {r.type === 'Check In' || r.type === 'Check Out' ? (
                          <i />
                        ) : r.type === 'Note' ? (
                          <FileText />
                        ) : (
                          <MapPin />
                        )}
                        {r.type}
                      </span>
                    </td>
                    <td>{r.location}</td>
                    <td>{r.note}</td>
                    <td>
                      {r.photo ? (
                        <span
                          className="ae-photo"
                          style={{ background: `linear-gradient(135deg,${r.photo},#2b2b2b)` }}
                        />
                      ) : (
                        <span className="ae-nophoto">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <section className="ae-card ae-summary">
          <div className="ae-card-head">
            <h2>
              <BarChart3 /> Today's Summary
            </h2>
            <button type="button" className="ae-link" onClick={() => navigate('/reports')}>
              See Reports
            </button>
          </div>
          <div className="ae-tiles">
            <div>
              <span className="ae-tile-icon">
                <Clock3 />
              </span>
              <div>
                <small>Working Hours</small>
                <b>
                  {h}h {m}m
                </b>
              </div>
              <div className="ae-delta">
                <em>↗ +12%</em>
                <small>vs. last week</small>
              </div>
            </div>
            <div>
              <span className="ae-tile-icon">
                <MapPin />
              </span>
              <div>
                <small>Visits Completed</small>
                <b>
                  {done} / {stops.length}
                </b>
              </div>
              <div className="ae-donut">
                <svg viewBox="0 0 40 40">
                  <circle cx="20" cy="20" r="16" fill="none" stroke="#DCEFE3" strokeWidth="5" />
                  <circle
                    cx="20"
                    cy="20"
                    r="16"
                    fill="none"
                    stroke="#0E8A45"
                    strokeWidth="5"
                    strokeDasharray={`${pct} 100`}
                    pathLength={100}
                    strokeLinecap="round"
                    transform="rotate(-90 20 20)"
                  />
                </svg>
                <b>{pct}%</b>
              </div>
            </div>
            <div>
              <span className="ae-tile-icon">
                <Route />
              </span>
              <div>
                <small>Distance Travelled</small>
                <b>24 km</b>
              </div>
              <div className="ae-delta">
                <em>↗ +8%</em>
                <small>vs. last week</small>
              </div>
            </div>
            <div>
              <span className="ae-tile-icon">
                <FileText />
              </span>
              <div>
                <small>Notes Added</small>
                <b>{notesAdded}</b>
              </div>
              <div className="ae-delta">
                <em>↗ +100%</em>
                <small>vs. last week</small>
              </div>
            </div>
          </div>
          <div className="ae-sync">
            <span>
              <CheckCircle2 />
              All data synced
            </span>
            <span>Last updated: {nowLabel(sec)}</span>
            <span className="ae-online">
              <Wifi />
              Online
            </span>
          </div>
        </section>
      </div>
    </div>
  )
}
