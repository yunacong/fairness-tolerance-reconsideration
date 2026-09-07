import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  Alert, AppBar, Box, Button, Checkbox, Chip, CircularProgress, Container, FormControl,
  FormControlLabel, FormLabel, LinearProgress, MenuItem, Paper, Radio, RadioGroup,
  Stack, TextField, Toolbar, Typography,
} from "@mui/material";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import { api } from "./api";
import { ScaleField } from "./components/ScaleField";
import { TradeoffChart } from "./components/TradeoffChart";
import { ViewCards } from "./components/ViewCards";
import type { Step, TradeoffView, ViewMetadata } from "./types";

const orderedSteps: Step[] = ["information", "consent", "background", "tutorial", "scenario", "orientation", "views", "pre", "tradeoff", "comprehension", "post", "nasa_tlx", "sus", "finish"];
const NASA_ITEMS = {
  mental: ["Mental demand", "How mentally demanding was the task?"],
  physical: ["Physical demand", "How physically demanding was the task?"],
  temporal: ["Temporal demand", "How hurried or rushed was the pace?"],
  performance: ["Performance", "How successful were you in accomplishing the task?"],
  effort: ["Effort", "How hard did you have to work?"],
  frustration: ["Frustration", "How insecure, discouraged, irritated, stressed, or annoyed were you?"],
} as const;
const SUS_ITEMS = [
  "I think that I would like to use this system frequently.",
  "I found the system unnecessarily complex.",
  "I thought the system was easy to use.",
  "I think that I would need the support of a technical person to use this system.",
  "I found the various functions in this system were well integrated.",
  "I thought there was too much inconsistency in this system.",
  "I would imagine that most people would learn to use this system very quickly.",
  "I found the system very cumbersome to use.",
  "I felt very confident using the system.",
  "I needed to learn a lot of things before I could get going with this system.",
];

type Identity = { participant_id: string; session_id: string };

const PARTICIPANT_ID_KEY = "fairness_participant_id";
const SESSION_ID_KEY = "fairness_session_id";
const LOCAL_RESEARCHER_HOSTS = new Set(["localhost", "127.0.0.1"]);

export function isLocalResearcherHost(hostname: string) {
  return LOCAL_RESEARCHER_HOSTS.has(hostname);
}

function Panel({ title, eyebrow, children }: { title: string; eyebrow?: string; children: ReactNode }) {
  return <Paper component="section" elevation={0} sx={{ p: { xs: 3, md: 5 }, border: "1px solid", borderColor: "divider" }}>
    {eyebrow && <Typography variant="overline" color="primary.main" fontWeight={800}>{eyebrow}</Typography>}
    <Typography variant="h2" component="h1" gutterBottom>{title}</Typography>
    {children}
  </Paper>;
}

export function App({ hostname = window.location.hostname }: { hostname?: string } = {}) {
  const [step, setStep] = useState<Step>("information");
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [views, setViews] = useState<ViewMetadata[]>([]);
  const [selectedView, setSelectedView] = useState("");
  const [preThreshold, setPreThreshold] = useState(20);
  const [preConfidence, setPreConfidence] = useState(3);
  const [tradeoff, setTradeoff] = useState<TradeoffView | null>(null);
  const [completion, setCompletion] = useState("");
  const enteredAt = useRef(performance.now());

  useEffect(() => {
    const participant_id = window.localStorage.getItem(PARTICIPANT_ID_KEY);
    const session_id = window.localStorage.getItem(SESSION_ID_KEY);
    if (!participant_id || !session_id) return;
    setIdentity({ participant_id, session_id });
    api.get<Record<string, unknown>>(`/api/sessions/${session_id}`).then((session) => {
      if (window.localStorage.getItem(PARTICIPANT_ID_KEY) !== participant_id || window.localStorage.getItem(SESSION_ID_KEY) !== session_id) return;
      const resumed = String(session.current_step) as Step;
      if (orderedSteps.includes(resumed)) setStep(resumed);
      const pre = session.pre as { threshold_pp?: number; confidence?: number } | undefined;
      const choice = session.choice as { view_id?: string } | undefined;
      if (pre?.threshold_pp != null) setPreThreshold(pre.threshold_pp);
      if (pre?.confidence != null) setPreConfidence(pre.confidence);
      if (choice?.view_id) setSelectedView(choice.view_id);
      if (session.completion_code) setCompletion(String(session.completion_code));
    }).catch(() => {
      if (window.localStorage.getItem(PARTICIPANT_ID_KEY) !== participant_id || window.localStorage.getItem(SESSION_ID_KEY) !== session_id) return;
      window.localStorage.removeItem(PARTICIPANT_ID_KEY);
      window.localStorage.removeItem(SESSION_ID_KEY);
      setIdentity(null);
    });
  }, []);

  useEffect(() => {
    enteredAt.current = performance.now();
    window.scrollTo({ top: 0, behavior: "instant" });
  }, [step]);

  useEffect(() => {
    if (!identity || !["views", "pre", "tradeoff", "comprehension", "post"].includes(step)) return;
    api.get<{ active_views: ViewMetadata[] }>(`/api/study/content?session_id=${identity.session_id}`)
      .then((result) => setViews(result.active_views)).catch((reason) => setError(reason.message));
  }, [identity, step]);

  const elapsed = () => Math.max(0, Math.round(performance.now() - enteredAt.current));
  const progress = Math.max(0, orderedSteps.indexOf(step)) / (orderedSteps.length - 1) * 100;

  async function act(task: () => Promise<void>) {
    setBusy(true); setError("");
    try { await task(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Something went wrong. Please try again."); }
    finally { setBusy(false); }
  }

  async function recordStep(next: Step) {
    if (identity) await api.patch(`/api/sessions/${identity.session_id}/step`, { step: next });
    setStep(next);
  }

  function startNextParticipant() {
    const confirmed = window.confirm("Start a new participant on this device? The completed participant data will remain saved.");
    if (!confirmed) return;

    window.localStorage.removeItem(PARTICIPANT_ID_KEY);
    window.localStorage.removeItem(SESSION_ID_KEY);
    setIdentity(null);
    setCompletion("");
    setViews([]);
    setSelectedView("");
    setPreThreshold(20);
    setPreConfidence(3);
    setTradeoff(null);
    setError("");
    setBusy(false);
    enteredAt.current = performance.now();
    setStep("information");
  }

  return <>
    <a className="skip-link" href="#study-main">Skip to study content</a>
    <AppBar position="sticky" elevation={0} color="inherit" sx={{ borderBottom: "1px solid", borderColor: "divider" }}>
      <Toolbar sx={{ gap: 2 }}>
        <Box sx={{ width: 38, height: 38, borderRadius: "12px", bgcolor: "primary.main", color: "primary.contrastText", display: "grid", placeItems: "center", fontWeight: 900 }}>F</Box>
        <Box sx={{ flex: 1 }}><Typography fontWeight={800}>Fairness & Credit Decisions</Typography><Typography variant="caption" color="text.secondary">Anonymous research study</Typography></Box>
        {identity && <Chip label={identity.participant_id} variant="outlined" aria-label={`Anonymous participant ${identity.participant_id}`} />}
      </Toolbar>
      <LinearProgress variant="determinate" value={progress} aria-label={`Study progress ${Math.round(progress)} percent`} />
    </AppBar>
    <Container id="study-main" component="main" maxWidth="lg" sx={{ py: { xs: 3, md: 6 } }} tabIndex={-1}>
      {error && <Alert severity="error" sx={{ mb: 3 }}>{error}</Alert>}
      {step === "information" && <Information onContinue={() => setStep("consent")} />}
      {step === "consent" && <Consent busy={busy} onSubmit={(payload) => act(async () => {
        const result = await api.post<Identity>("/api/consent", payload);
        window.localStorage.setItem(PARTICIPANT_ID_KEY, result.participant_id);
        window.localStorage.setItem(SESSION_ID_KEY, result.session_id);
        setIdentity(result); setStep("background");
      })} />}
      {step === "background" && identity && <Background busy={busy} onSubmit={(payload) => act(async () => {
        await api.post(`/api/sessions/${identity.session_id}/background`, payload); setStep("tutorial");
      })} />}
      {step === "tutorial" && identity && <Tutorial busy={busy} onSubmit={(payload) => act(async () => {
        await api.post(`/api/sessions/${identity.session_id}/tutorial`, payload); setStep("scenario");
      })} />}
      {step === "scenario" && <Panel title="Credit decision scenario" eyebrow="Step 4">
        <Typography paragraph>You are advising a team that uses an AI system to support credit decisions. The fixed test dataset contains 200 past applicants from the German Credit dataset. An expert rating is the actual outcome; the AI prediction is the model's suggested Good or Bad Credit outcome.</Typography>
        <Alert severity="info" sx={{ my: 3 }}>Your task is not to approve an individual applicant. You will state how much difference between groups you consider tolerable, then review feasible fairness–accuracy combinations.</Alert>
        <Button variant="contained" onClick={() => act(() => recordStep("orientation"))} disabled={busy}>Continue to fairness orientation</Button>
      </Panel>}
      {step === "orientation" && <Panel title="How group fairness is represented" eyebrow="Step 5">
        <Stack spacing={2}>
          <Typography><strong>Fairness View:</strong> one complete pairing of a group concern and a fairness metric.</Typography>
          <Typography><strong>Fairness disparity:</strong> the observed difference between two groups, measured from 0 to 100 percentage points. Lower means a smaller observed difference.</Typography>
          <Typography><strong>Participant fairness-tolerance threshold:</strong> the largest disparity you personally consider acceptable. This is your judgement.</Typography>
          <Typography><strong>Model configuration:</strong> one feasible technical setting. Its internal classification cutoff is not part of your task and will not be shown.</Typography>
        </Stack>
        <Button variant="contained" sx={{ mt: 4 }} onClick={() => act(() => recordStep("views"))} disabled={busy}>Choose a Fairness View</Button>
      </Panel>}
      {step === "views" && identity && <Panel title="Which complete Fairness View matters most to you?" eyebrow="Step 6">
        <Typography color="text.secondary" sx={{ mb: 3 }}>The order of these validated cards is randomized. No option is preselected. Choose one view for the remainder of the study.</Typography>
        {views.length ? <ViewCards views={views} value={selectedView} onChange={setSelectedView} /> : <CircularProgress aria-label="Loading Fairness Views" />}
        <Button variant="contained" sx={{ mt: 4 }} disabled={!selectedView || busy} onClick={() => act(async () => {
          await api.post(`/api/sessions/${identity.session_id}/fairness-choice`, { view_id: selectedView, decision_ms: elapsed() }); setStep("pre");
        })}>Confirm selected view</Button>
      </Panel>}
      {step === "pre" && identity && <Panel title="Initial fairness tolerance (PRE)" eyebrow="Step 7">
        <Typography>Before seeing any fairness–accuracy combinations, set the largest disparity you consider acceptable for your selected Fairness View.</Typography>
        <ScaleField label="Initial fairness tolerance, percentage points" value={preThreshold} onChange={setPreThreshold} lowLabel="0 — no observed gap" highLabel="100 — largest possible gap" />
        <ScaleField label="Confidence in initial decision" value={preConfidence} onChange={setPreConfidence} min={1} max={5} lowLabel="1 — not confident" highLabel="5 — very confident" />
        <Button variant="contained" disabled={busy} onClick={() => act(async () => {
          await api.post(`/api/sessions/${identity.session_id}/pre`, { threshold_pp: preThreshold, confidence: preConfidence, decision_ms: elapsed() });
          const result = await api.post<{ view: TradeoffView }>(`/api/sessions/${identity.session_id}/tradeoff-exposure`, {});
          setTradeoff(result.view); setStep("tradeoff");
        })}>Save PRE decision and view trade-off</Button>
      </Panel>}
      {step === "tradeoff" && <Panel title="Fairness disparity × Accuracy" eyebrow="Step 8">
        {tradeoff ? <TradeoffChart view={tradeoff} /> : <CircularProgress aria-label="Loading trade-off data" />}
        <Alert severity="warning" sx={{ mt: 3 }}>The horizontal value is fairness disparity, not your tolerance threshold. Your initial tolerance was {preThreshold} percentage points.</Alert>
        <Button variant="contained" sx={{ mt: 3 }} disabled={!tradeoff} onClick={() => setStep("comprehension")}>Continue to understanding check</Button>
      </Panel>}
      {step === "comprehension" && identity && <Comprehension busy={busy} onComplete={() => setStep("post")} submit={(question_id, answer) => api.post(`/api/sessions/${identity.session_id}/comprehension`, { question_id, answer })} />}
      {step === "post" && identity && <Post busy={busy} preThreshold={preThreshold} onSubmit={(payload) => act(async () => {
        await api.post(`/api/sessions/${identity.session_id}/post`, { ...payload, decision_ms: elapsed() }); setStep("nasa_tlx");
      })} />}
      {step === "nasa_tlx" && identity && <NasaTlx busy={busy} onSubmit={(items) => act(async () => {
        await api.post(`/api/sessions/${identity.session_id}/nasa-tlx`, { items }); setStep("sus");
      })} />}
      {step === "sus" && identity && <Sus busy={busy} onSubmit={(items) => act(async () => {
        await api.post(`/api/sessions/${identity.session_id}/sus`, { items });
        const result = await api.post<{ completion_code: string }>(`/api/sessions/${identity.session_id}/finish`, {});
        setCompletion(result.completion_code); setStep("finish");
      })} />}
      {step === "finish" && <Panel title="Study complete" eyebrow="Thank you">
        <CheckCircleOutlineIcon color="primary" sx={{ fontSize: 64 }} aria-hidden="true" />
        <Typography paragraph sx={{ mt: 2 }}>This study examines how lay stakeholders' fairness-tolerance decisions change after seeing fairness–accuracy information. There is no control group, and results will not be described as a strict causal effect.</Typography>
        <Typography>Your anonymous completion code is:</Typography>
        <Typography variant="h2" component="p" sx={{ my: 2, letterSpacing: 2 }}>{completion || "Loading…"}</Typography>
        <Typography color="text.secondary">Please copy this code before closing the page. No directly identifying information was requested.</Typography>
        {isLocalResearcherHost(hostname) && <Paper
          component="aside"
          aria-label="Local researcher control"
          variant="outlined"
          sx={{ mt: 4, p: 2.5, borderStyle: "dashed", bgcolor: "grey.50" }}
        >
          <Typography variant="overline" color="text.secondary" fontWeight={800}>Researcher control</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
            Local researcher control — clears this browser session only; completed data remains saved.
          </Typography>
          <Button variant="outlined" onClick={startNextParticipant}>Start next participant</Button>
        </Paper>}
      </Panel>}
    </Container>
  </>;
}

function Information({ onContinue }: { onContinue: () => void }) {
  return <Panel title="How do people judge fairness when accuracy also matters?" eyebrow="Research information">
    <Typography variant="h3" component="h2" sx={{ mt: 3 }}>What you will do</Typography>
    <Typography paragraph>You will learn about an AI-supported credit scenario, choose one Fairness View, make an initial tolerance decision, inspect fairness–accuracy model configurations, answer two understanding questions, make a final decision, and complete Raw NASA-TLX and SUS questionnaires.</Typography>
    <Stack direction={{ xs: "column", sm: "row" }} spacing={2} sx={{ my: 3 }}><Chip label="About 15–20 minutes" /><Chip label="Anonymous participant ID" /><Chip label="You may stop at any time" /></Stack>
    <Typography variant="h3" component="h2">Data and withdrawal</Typography>
    <Typography paragraph>The system stores your anonymous responses and task timings for research. It does not ask for your name, email, or credit information. You may close the study before submitting consent. After anonymous submission, withdrawal may require your participant code because no identity is linked.</Typography>
    <Typography variant="h3" component="h2">Voluntary participation</Typography>
    <Typography paragraph>Participation is voluntary. There are no right or wrong fairness opinions. The understanding questions only confirm that the chart is interpreted as intended.</Typography>
    <Button variant="contained" onClick={onContinue}>Continue to consent</Button>
  </Panel>;
}

function Consent({ onSubmit, busy }: { onSubmit: (payload: Record<string, unknown>) => void; busy: boolean }) {
  const [checks, setChecks] = useState({ adult: false, informed: false, voluntary: false, data_processing: false });
  const complete = Object.values(checks).every(Boolean);
  return <Panel title="Consent" eyebrow="Before participant IDs are created">
    <Typography paragraph>A participant ID and session ID are created together only after all statements are confirmed and you submit this form.</Typography>
    <FormControl component="fieldset"><FormLabel component="legend">Please confirm every statement</FormLabel>
      {([
        ["adult", "I am aged 18 or over."], ["informed", "I have read and understood the research information."],
        ["voluntary", "I understand participation is voluntary and I may stop."],
        ["data_processing", "I consent to anonymous study responses being stored and analysed for research."],
      ] as const).map(([key, label]) => <FormControlLabel key={key} control={<Checkbox checked={checks[key]} onChange={(event) => setChecks({ ...checks, [key]: event.target.checked })} />} label={label} />)}
    </FormControl>
    <Box><Button variant="contained" sx={{ mt: 3 }} disabled={!complete || busy} onClick={() => onSubmit({ ...checks, consent_version: "1.0.0", idempotency_key: crypto.randomUUID() })}>I consent and want to begin</Button></Box>
  </Panel>;
}

function Background({ onSubmit, busy }: { onSubmit: (payload: Record<string, unknown>) => void; busy: boolean }) {
  const [form, setForm] = useState({ age_range: "", gender: "", education: "", ai_familiarity: 3 });
  const ready = form.age_range && form.gender && form.education;
  return <Panel title="Background" eyebrow="Step 2"><Stack component="form" spacing={3} onSubmit={(event: FormEvent) => { event.preventDefault(); if (ready) onSubmit(form); }}>
    <TextField select required label="Age range" value={form.age_range} onChange={(event) => setForm({ ...form, age_range: event.target.value })}>{["18-24", "25-34", "35-44", "45-54", "55-64", "65+", "prefer_not_to_say"].map((value) => <MenuItem key={value} value={value}>{value.replaceAll("_", " ")}</MenuItem>)}</TextField>
    <TextField select required label="Gender" value={form.gender} onChange={(event) => setForm({ ...form, gender: event.target.value })}>{["woman", "man", "non_binary", "self_describe", "prefer_not_to_say"].map((value) => <MenuItem key={value} value={value}>{value.replaceAll("_", " ")}</MenuItem>)}</TextField>
    <TextField select required label="Highest education" value={form.education} onChange={(event) => setForm({ ...form, education: event.target.value })}>{["secondary_or_less", "college", "undergraduate", "postgraduate", "other", "prefer_not_to_say"].map((value) => <MenuItem key={value} value={value}>{value.replaceAll("_", " ")}</MenuItem>)}</TextField>
    <ScaleField label="Familiarity with AI" value={form.ai_familiarity} onChange={(value) => setForm({ ...form, ai_familiarity: value })} min={1} max={5} lowLabel="1 — none" highLabel="5 — very familiar" />
    <Button type="submit" variant="contained" disabled={!ready || busy}>Save and continue</Button>
  </Stack></Panel>;
}

function Tutorial({ onSubmit, busy }: { onSubmit: (payload: Record<string, unknown>) => void; busy: boolean }) {
  const [checks, setChecks] = useState({ probability: false, thresholds: false });
  return <Panel title="Tutorial: data, predictions, and two thresholds" eyebrow="Step 3">
    <Box className="tutorial-grid">
      <Paper variant="outlined" sx={{ p: 3 }}><Typography variant="h3">Actual vs predicted</Typography><Typography>The <strong>Actual rating</strong> is the expert outcome. The <strong>Predicted rating</strong> is the AI system's suggested Good or Bad Credit result.</Typography></Paper>
      <Paper variant="outlined" sx={{ p: 3 }}><Typography variant="h3">Probability</Typography><Typography>A Good Credit probability of 0.72 means the model assigns a 72% score to Good Credit. The committed research asset already contains these scores; no model is trained during the study.</Typography></Paper>
      <Paper variant="outlined" sx={{ p: 3 }}><Typography variant="h3">Your tolerance</Typography><Typography>Your 0–100 fairness-tolerance threshold is a judgement about the largest group disparity you accept.</Typography></Paper>
      <Paper variant="outlined" sx={{ p: 3 }}><Typography variant="h3">Technical model cutoff</Typography><Typography>The model internally converts probabilities into predictions. That classification cutoff is researcher-side only and is never the participant threshold.</Typography></Paper>
    </Box>
    <Paper variant="outlined" sx={{ my: 3, p: 2, overflowX: "auto" }} tabIndex={0} aria-label="Scrollable example table">
      <Typography fontWeight={700}>Scrollable example — move horizontally if needed</Typography>
      <Box component="table" sx={{ minWidth: 720, width: "100%", mt: 1 }}><tbody><tr><th>Applicant</th><th>Actual rating</th><th>Predicted rating</th><th>Good Credit probability</th><th>Meaning</th></tr><tr><td>A-101</td><td>Good</td><td>Good</td><td>72%</td><td>The prediction matches the expert rating.</td></tr></tbody></Box>
    </Paper>
    <FormControlLabel control={<Checkbox checked={checks.probability} onChange={(event) => setChecks({ ...checks, probability: event.target.checked })} />} label="I understand the difference between actual, predicted, and probability." />
    <FormControlLabel control={<Checkbox checked={checks.thresholds} onChange={(event) => setChecks({ ...checks, thresholds: event.target.checked })} />} label="I understand that my fairness tolerance is not the model classification cutoff." />
    <Box><Button variant="contained" sx={{ mt: 3 }} disabled={!checks.probability || !checks.thresholds || busy} onClick={() => onSubmit({ completed: true, understood_probability: true, understood_thresholds: true })}>Complete tutorial</Button></Box>
  </Panel>;
}

function Comprehension({ submit, onComplete, busy }: { submit: (question: string, answer: string) => Promise<{ correct: boolean; explanation: string }>; onComplete: () => void; busy: boolean }) {
  const [answers, setAnswers] = useState({ meaning_of_lower_disparity: "", meaning_of_points: "" });
  const [correct, setCorrect] = useState<Record<string, boolean>>({});
  const [feedback, setFeedback] = useState<Record<string, string>>({});
  const send = async () => {
    const next = { ...correct }; const messages = { ...feedback };
    for (const question of Object.keys(answers) as Array<keyof typeof answers>) {
      if (next[question]) continue;
      const result = await submit(question, answers[question]); next[question] = result.correct; messages[question] = result.explanation;
    }
    setCorrect(next); setFeedback(messages); if (next.meaning_of_lower_disparity && next.meaning_of_points) onComplete();
  };
  return <Panel title="Understanding check" eyebrow="Step 9"><Stack spacing={4}>
    <FormControl><FormLabel id="q1">What does a lower fairness disparity mean?</FormLabel><RadioGroup aria-labelledby="q1" value={answers.meaning_of_lower_disparity} onChange={(event) => setAnswers({ ...answers, meaning_of_lower_disparity: event.target.value })}>
      <FormControlLabel value="lower" control={<Radio />} label="The observed difference between the two groups is smaller." /><FormControlLabel value="accuracy" control={<Radio />} label="The model is always less accurate." /><FormControlLabel value="cutoff" control={<Radio />} label="My personal tolerance is automatically lower." />
    </RadioGroup>{feedback.meaning_of_lower_disparity && <Alert severity={correct.meaning_of_lower_disparity ? "success" : "warning"}>{feedback.meaning_of_lower_disparity}</Alert>}</FormControl>
    <FormControl><FormLabel id="q2">What does each chart point represent?</FormLabel><RadioGroup aria-labelledby="q2" value={answers.meaning_of_points} onChange={(event) => setAnswers({ ...answers, meaning_of_points: event.target.value })}>
      <FormControlLabel value="configurations" control={<Radio />} label="A feasible model configuration with a disparity and accuracy result." /><FormControlLabel value="participants" control={<Radio />} label="One participant's fairness opinion." /><FormControlLabel value="groups" control={<Radio />} label="One demographic group." />
    </RadioGroup>{feedback.meaning_of_points && <Alert severity={correct.meaning_of_points ? "success" : "warning"}>{feedback.meaning_of_points}</Alert>}</FormControl>
    <Button variant="contained" disabled={!answers.meaning_of_lower_disparity || !answers.meaning_of_points || busy} onClick={send}>{Object.values(feedback).length ? "Check again" : "Check answers"}</Button>
  </Stack></Panel>;
}

function Post({ preThreshold, onSubmit, busy }: { preThreshold: number; onSubmit: (payload: Record<string, unknown>) => void; busy: boolean }) {
  const [decision, setDecision] = useState(""); const [final, setFinal] = useState(preThreshold); const [confidence, setConfidence] = useState(3); const [feasibility, setFeasibility] = useState(3); const [reason, setReason] = useState("");
  useEffect(() => { if (decision === "KEEP") setFinal(preThreshold); }, [decision, preThreshold]);
  return <Panel title="Final fairness tolerance (POST)" eyebrow="Step 10">
    <FormControl><FormLabel id="post-decision">After seeing the trade-off information, will you keep or revise your initial threshold of {preThreshold}?</FormLabel><RadioGroup row aria-labelledby="post-decision" value={decision} onChange={(event) => setDecision(event.target.value)}><FormControlLabel value="KEEP" control={<Radio />} label="KEEP" /><FormControlLabel value="REVISE" control={<Radio />} label="REVISE" /></RadioGroup></FormControl>
    <ScaleField label="Final fairness tolerance, percentage points" value={final} onChange={setFinal} lowLabel="0 — no observed gap" highLabel="100 — largest possible gap" />
    <ScaleField label="Confidence in final decision" value={confidence} onChange={setConfidence} min={1} max={5} lowLabel="1 — not confident" highLabel="5 — very confident" />
    <ScaleField label="How feasible did your preferred tolerance seem?" value={feasibility} onChange={setFeasibility} min={1} max={5} lowLabel="1 — not feasible" highLabel="5 — very feasible" />
    <TextField fullWidth multiline minRows={3} label="Optional: What influenced your final decision?" value={reason} onChange={(event) => setReason(event.target.value)} inputProps={{ maxLength: 2000 }} helperText="Optional. This answer is stored next to your POST decision." />
    <Button variant="contained" sx={{ mt: 3 }} disabled={!decision || busy} onClick={() => onSubmit({ decision, final_threshold_pp: decision === "KEEP" ? preThreshold : final, confidence, feasibility, reason_optional: reason })}>Save final decision</Button>
  </Panel>;
}

function NasaTlx({ onSubmit, busy }: { onSubmit: (items: Record<string, number>) => void; busy: boolean }) {
  const [items, setItems] = useState<Record<string, number>>(Object.fromEntries(Object.keys(NASA_ITEMS).map((key) => [key, 50])));
  return <Panel title="Raw NASA-TLX" eyebrow="Step 11"><Typography paragraph>Rate each dimension from 0 to 100. Raw item responses are stored without weighting.</Typography>
    {Object.entries(NASA_ITEMS).map(([key, [label, description]]) => <ScaleField key={key} label={`${label} — ${description}`} value={items[key]!} onChange={(value) => setItems({ ...items, [key]: value })} lowLabel="0 — very low" highLabel="100 — very high" />)}
    <Button variant="contained" disabled={busy} onClick={() => onSubmit(items)}>Save Raw NASA-TLX</Button>
  </Panel>;
}

function Sus({ onSubmit, busy }: { onSubmit: (items: number[]) => void; busy: boolean }) {
  const [items, setItems] = useState<number[]>(Array(10).fill(0));
  const complete = items.every((value) => value >= 1 && value <= 5);
  return <Panel title="System Usability Scale (SUS)" eyebrow="Step 12"><Typography paragraph>For each statement, choose 1 (strongly disagree) to 5 (strongly agree). All ten raw responses are saved.</Typography>
    <Stack spacing={3}>{SUS_ITEMS.map((statement, index) => <FormControl key={statement}><FormLabel id={`sus-${index + 1}`}>{index + 1}. {statement}</FormLabel><RadioGroup row aria-labelledby={`sus-${index + 1}`} value={items[index] || ""} onChange={(event) => { const next = [...items]; next[index] = Number(event.target.value); setItems(next); }}>{[1, 2, 3, 4, 5].map((value) => <FormControlLabel key={value} value={value} control={<Radio />} label={String(value)} />)}</RadioGroup></FormControl>)}</Stack>
    <Button variant="contained" sx={{ mt: 4 }} disabled={!complete || busy} onClick={() => onSubmit(items)}>Submit questionnaire and finish</Button>
  </Panel>;
}
