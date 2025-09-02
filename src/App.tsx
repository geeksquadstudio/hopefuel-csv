// File: src/App.tsx
// Hope Fuel PRF Bulk Import & Member Categorization – MVP (React + TS)
// Month comes from CSV; Country mapping hard-coded; Only .csv accepted.

import React, { useMemo, useState } from "react";
import { motion, Variants } from "framer-motion";
import Papa from "papaparse";
import JSZip from "jszip";
import saveAs from "file-saver"; // default import
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Upload, Download, FileWarning, XCircle, RefreshCw, FileCog, Info } from "lucide-react";

// -------------------------- Types & Constants --------------------------

const INPUT_HEADERS = [
  "Name","Email","Country","CardID","TotalAmount","Currency","Month","SupportRegion","HQID","TransactionDate","PaymentCheckDate","FormFillingPerson","Note",
] as const;

const CANONICAL_WITH_MONTH = [...INPUT_HEADERS] as const;

type RowMsg = { line: number; code: string; message: string };

type JobStatus =
  | "Idle" | "Validating" | "Transforming" | "Splitting" | "Naming" | "Packaging" | "Complete" | "Failed";

type ProcessCounts = { total: number; valid: number; newCount: number; oldCount: number; warnings: number; errors: number };

const CODES = {
  ERR: {
    HEADERS_MISSING: "E-HEADERS-MISSING",
    HEADERS_EXTRA: "E-HEADERS-EXTRA",
    ROW_COLS: "E-ROW-COLS",
    EMAIL: "E-EMAIL-FORMAT",
    AMOUNT_NUM: "E-AMOUNT-NUM",
    AMOUNT_POS: "E-AMOUNT-POS",
    CURR_CODE: "E-CURR-CODE",
    CARDID_NONNUM: "E-CARDID-NONNUM",
    CARDID_ZERO: "E-CARDID-ZERO",
    FILE_LIMIT: "E-FILE-LIMIT",
    FILE_TYPE: "E-FILE-TYPE",
    MULTI_FILE: "E-MULTI-FILE",
  },
  WARN: {
    HEADERS_REORDERED: "W-HEADERS-REORDERED",
    CARDID_LONG: "W-CARDID-LONG",
    HQID_NONNUM: "W-HQID-NONNUM",
    COUNTRY_UNMAPPED: "W-COUNTRY-UNMAPPED",
    DUP_EXACT: "W-DUP-EXACT",
    MONTH_IGNORED: "W-MONTH-IGNORED",
  },
} as const;

const COUNTRY_MAP: Record<string, string> = { Myanmar: "MM", Thailand: "TH" };

const MAX_BYTES = 25 * 1024 * 1024; // 25MB
const MAX_ROWS = 50000; // data rows (excluding header)

// -------------------------- Utility helpers --------------------------

const normHeader = (h: string) => h.toLowerCase().replace(/\s+|_/g, "");
const utcYYYYMMDD = () => { const d = new Date(); return d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2, "0") + String(d.getUTCDate()).padStart(2, "0"); };
const isValidEmail = (s: string) => /^(?!.{255,})[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(s.trim());
const normalizeCurrency = (s: string) => s.trim().toUpperCase();
const isValidCurrency = (s: string) => /^[A-Z]{3}$/.test(normalizeCurrency(s));
const isValidAmount = (s: string) => /^\d{1,18}(\.\d{1,2})?$/.test(s.trim());
const isValidISODate = (s: string) => !Number.isNaN(Date.parse(s.trim()));
const normalizeMonth = (s: string) => String(s ?? '').trim();
const isValidMonth = (s: string) => /^(?:[1-9]|1[0-2])$/.test(normalizeMonth(s));
const trimTo = (arr: string[], n: number): string[] => Array.from({ length: n }, (_, i) => (arr[i] ?? "").trim());
const dupKeyOf = (arr: string[]) => arr.map((v) => (v ?? "").trim()).join("\u001F");
const mapCountry = (name: string) => COUNTRY_MAP[name.trim()] ?? "ZZ";
const buildNewCardId = (digits: string): { value: string; long: boolean } => digits.length > 7 ? { value: `PRF-${digits}`, long: true } : { value: `PRF-${digits.padStart(7, "0")}`, long: false };
const csvOf = (header: string[], rows: string[][]) => Papa.unparse([header, ...rows], { quotes: true, newline: "\r\n" });

function downloadBlob(blob: Blob, filename: string, opts?: { openFallback?: boolean }) {
  try { (saveAs as any)(blob, filename); return; } catch {}
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = filename; a.rel = "noopener";
  document.body.appendChild(a); a.click();
  if (opts?.openFallback) { setTimeout(() => { try { window.open(url, "_blank", "noopener"); } catch {} }, 150); }
  setTimeout(() => { try { document.body.removeChild(a); } catch {}; URL.revokeObjectURL(url); }, 1000);
}

function openBlobInNewTab(blob: Blob) {
  const url = URL.createObjectURL(blob);
  try { window.open(url, "_blank", "noopener"); } finally { setTimeout(() => URL.revokeObjectURL(url), 30000); }
}

const chunk = <T,>(arr: T[], n = 300) => { const out: T[][] = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
const jobId = () => "J-" + utcYYYYMMDD() + "-" + Math.random().toString(36).slice(2, 8).toUpperCase();

// --- Filename helpers (PRD exact shapes — NO chunk suffix) ---
const makeSeq = (startSeq: string) => { const width = startSeq.length; let n = parseInt(startSeq, 10); return () => String(n++).padStart(width, "0"); };
const newFileName = (seq: string, dateUTC: string, _idx: number, _total: number) => `${seq}_prf_bulk_import_${dateUTC}.csv`;
const oldFileName = (seq: string, dateUTC: string, _idx: number, _total: number) => `${seq}_extension_prf_bulk_import_${dateUTC}.csv`;
function buildFileNames(newCount: number, oldCount: number, startSeq: string, dateUTC: string) {
  const nextSeq = makeSeq(startSeq);
  const newNames = Array.from({ length: newCount }, (_, i) => newFileName(nextSeq(), dateUTC, i, newCount));
  const oldNames = Array.from({ length: oldCount }, (_, i) => oldFileName(nextSeq(), dateUTC, i, oldCount));
  return { newNames, oldNames };
}

// Simulated stage delays for richer UX
const STAGE_DELAYS = { Validating: 800, Transforming: 1000, Splitting: 800, Naming: 800, Packaging: 1000 } as const;
const DELAY_MULTIPLIER = 1.6;
const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

// Strict CSV gating
const isCsvFileName = (name: string) => /\.csv$/i.test(name.trim());
const isCsvMime = (type: string) => type === "text/csv" || type === "application/vnd.ms-excel" || type === "";

const downloadErrorsCsv = (rows: RowMsg[], name = `errors_${utcYYYYMMDD()}.csv`) => {
  const csv = csvOf(["line", "code", "message"], rows.map((m) => [String(m.line), m.code, m.message]));
  downloadBlob(new Blob([csv], { type: "text/csv;charset=utf-8" }), name);
};

// -------------------------- Component --------------------------

export default function App() {
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [startSeq, setStartSeq] = useState<string>("");
  const [status, setStatus] = useState<JobStatus>("Idle");
  const [msgsErr, setMsgsErr] = useState<RowMsg[]>([]);
  const [msgsWarn, setMsgsWarn] = useState<RowMsg[]>([]);
  const [counts, setCounts] = useState<ProcessCounts>({ total: 0, valid: 0, newCount: 0, oldCount: 0, warnings: 0, errors: 0 });
  const [summary, setSummary] = useState<{ newFiles: string[]; oldFiles: string[]; dateUTC: string; jobId: string; seqRange?: string; zipName?: string } | null>(null);
  const [uploadError, setUploadError] = useState<string>("");
  const [dndActive, setDndActive] = useState<boolean>(false);
  const [zipBlob, setZipBlob] = useState<Blob | null>(null);
  const [zipFileName, setZipFileName] = useState<string>("");
  const [fileInputKey, setFileInputKey] = useState<number>(0);
  const [stageIdx, setStageIdx] = useState<number>(-1);

  const startSeqValid = useMemo(() => /^\d{3,}$/.test(startSeq), [startSeq]);
  const canStart = !!csvFile && startSeqValid && !uploadError && status !== "Validating" && status !== "Packaging";

  const handleReset = () => {
    setStatus("Idle"); setMsgsErr([]); setMsgsWarn([]);
    setCounts({ total: 0, valid: 0, newCount: 0, oldCount: 0, warnings: 0, errors: 0 });
    setSummary(null); setUploadError(""); setCsvFile(null); setStartSeq(""); setFileInputKey(k => k + 1);
    setZipBlob(null); setZipFileName(""); setStageIdx(-1);
  };

  const readFileText = (f: File) => new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onabort = () => reject(new Error("Aborted"));
    reader.onload = () => resolve(String(reader.result ?? "").replace(/^\uFEFF/, ""));
    reader.readAsText(f, "utf-8");
  });

  const acceptCsvFile = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    if (files.length > 1) { setUploadError("Upload one CSV at a time"); setCsvFile(null); return; }
    const f = files[0];
    if (!isCsvFileName(f.name) || !isCsvMime(f.type)) { setUploadError("Only .csv files are supported."); setCsvFile(null); return; }
    if (f.size > MAX_BYTES) { setUploadError("File exceeds limits (25MB/50k rows)"); setCsvFile(null); return; }
    setUploadError(""); setCsvFile(f);
  };

  const startProcessing = async () => {
    if (!csvFile || !startSeqValid) return;

    setStatus("Validating"); setStageIdx(0); setMsgsErr([]); setMsgsWarn([]);
    setCounts({ total: 0, valid: 0, newCount: 0, oldCount: 0, warnings: 0, errors: 0 }); setSummary(null);

    await sleep(STAGE_DELAYS.Validating * DELAY_MULTIPLIER);
    const csvText = await readFileText(csvFile);
    const parsed = Papa.parse<string[]>(csvText, { skipEmptyLines: true });

    if (parsed.errors?.length) {
      const errs: RowMsg[] = [{ line: 1, code: CODES.ERR.ROW_COLS, message: `CSV parse error: ${parsed.errors[0].message}` }];
      setMsgsErr(errs); setStatus("Failed"); downloadErrorsCsv(errs); return;
    }

    const rowsRaw = parsed.data as unknown as string[][];
    if (!rowsRaw.length) {
      const errs: RowMsg[] = [{ line: 1, code: CODES.ERR.HEADERS_MISSING, message: "Empty file or missing header" }];
      setMsgsErr(errs); setStatus("Failed"); downloadErrorsCsv(errs); return;
    }

    const header = (rowsRaw[0] ?? []).map((h) => String(h ?? ""));
    const body = rowsRaw.slice(1);
    const bodyLens = body.map((r) => r.length);
    if (body.length > MAX_ROWS) { setUploadError("File exceeds limits (25MB/50k rows)"); setStatus("Idle"); return; }

    const normIncoming = header.map(normHeader);
    const normRequired = INPUT_HEADERS.map(normHeader);
    const normAllowed = [...normRequired];

    const missing: string[] = []; const extra: string[] = [];

    const mapIdx: number[] = [];
    for (let i = 0; i < CANONICAL_WITH_MONTH.length; i++) {
      const idx = normIncoming.indexOf(normHeader(CANONICAL_WITH_MONTH[i]));
      mapIdx.push(idx);
    }

    for (let i = 0; i < normRequired.length; i++) {
      const idx = normIncoming.indexOf(normRequired[i]);
      if (idx === -1) missing.push(INPUT_HEADERS[i]);
    }

    for (let i = 0; i < normIncoming.length; i++) if (!normAllowed.includes(normIncoming[i])) extra.push(header[i] ?? `#${i + 1}`);

    if (missing.length || extra.length) {
      const errs: RowMsg[] = [];
      if (missing.length) errs.push({ line: 1, code: CODES.ERR.HEADERS_MISSING, message: `Missing headers: ${missing.join(", ")}` });
      if (extra.length) errs.push({ line: 1, code: CODES.ERR.HEADERS_EXTRA, message: `Extra headers: ${extra.join(", ")}` });
      setMsgsErr(errs); setStatus("Failed"); downloadErrorsCsv(errs); return;
    }

    const reordered = body.map((r) => mapIdx.map((idx) => (idx >= 0 ? (r[idx] ?? "") : "")));
    if (header.some((_, i) => normHeader(header[i] ?? "") !== normHeader(INPUT_HEADERS[i] ?? header[i] ?? ""))) {
      setMsgsWarn((prev) => [...prev, { line: 1, code: CODES.WARN.HEADERS_REORDERED, message: "Headers auto-reordered to canonical order" }]);
    }

    setStatus("Transforming"); setStageIdx(1); await sleep(STAGE_DELAYS.Transforming * DELAY_MULTIPLIER);

    const seen = new Set<string>();

    type ExportRowNew = [string, string, string, string, string, string, string, string];
    type ExportRowOld = [string, string, string, string, string, string];
    const outNew: ExportRowNew[] = []; const outOld: ExportRowOld[] = [];
    const warn: RowMsg[] = []; const err: RowMsg[] = [];

    let total = 0; let valid = 0;

    reordered.forEach((r, idx) => {
      const physicalLine = idx + 2; total++;

      if (bodyLens[idx] !== header.length) { err.push({ line: physicalLine, code: CODES.ERR.ROW_COLS, message: `Expected ${header.length} columns, got ${bodyLens[idx]}` }); return; }

      const arr = trimTo(r, CANONICAL_WITH_MONTH.length);
      const [Name, Email, Country, CardID, TotalAmount, Currency, MonthFromCsv, SupportRegion, HQID, TransactionDate, PaymentCheckDate, FormFillingPerson, Note] = arr;

      const key = dupKeyOf(arr);
      if (seen.has(key)) { warn.push({ line: physicalLine, code: CODES.WARN.DUP_EXACT, message: "Exact duplicate dropped" }); return; }
      seen.add(key);

      if (!Name || Name.length > 200) { err.push({ line: physicalLine, code: CODES.ERR.ROW_COLS, message: "Invalid Name length" }); return; }
      if (!isValidEmail(Email)) { err.push({ line: physicalLine, code: CODES.ERR.EMAIL, message: `Invalid email: ${Email}` }); return; }
      if (!isValidAmount(TotalAmount)) { err.push({ line: physicalLine, code: CODES.ERR.AMOUNT_NUM, message: `Invalid amount: ${TotalAmount}` }); return; }
      if (parseFloat(TotalAmount) <= 0) { err.push({ line: physicalLine, code: CODES.ERR.AMOUNT_POS, message: `Amount must be > 0` }); return; }

      const curNorm = normalizeCurrency(Currency);
      if (!isValidCurrency(curNorm)) { err.push({ line: physicalLine, code: CODES.ERR.CURR_CODE, message: `Invalid currency: ${Currency}` }); return; }

      const monthOut = normalizeMonth(MonthFromCsv);
      if (!isValidMonth(monthOut)) { err.push({ line: physicalLine, code: CODES.ERR.ROW_COLS, message: `Invalid Month: ${MonthFromCsv}` }); return; }

      if (!isValidISODate(TransactionDate) || !isValidISODate(PaymentCheckDate)) { err.push({ line: physicalLine, code: CODES.ERR.ROW_COLS, message: `Invalid dates` }); return; }

      const cardTrim = CardID.trim();
      const isNew = cardTrim === "";
      if (!isNew) {
        if (!/^\d+$/.test(cardTrim)) { err.push({ line: physicalLine, code: CODES.ERR.CARDID_NONNUM, message: `CardID must be digits` }); return; }
        if (cardTrim === "0") { err.push({ line: physicalLine, code: CODES.ERR.CARDID_ZERO, message: `CardID cannot be zero` }); return; }
      }

      const noteHQ = `PRFHQ-${HQID.trim()}`;
      if (/[^0-9]/.test(HQID.trim())) warn.push({ line: physicalLine, code: CODES.WARN.HQID_NONNUM, message: `HQID contains non-digits` });

      const mappedCountry = mapCountry(Country);
      if (mappedCountry === "ZZ") warn.push({ line: physicalLine, code: CODES.WARN.COUNTRY_UNMAPPED, message: `Country '${Country}' unmapped; set 'ZZ'` });

      if (isNew) { outNew.push([Name, Email, mappedCountry, TotalAmount, curNorm, monthOut, SupportRegion, noteHQ]); }
      else {
        const { value: prfCardNo, long } = buildNewCardId(cardTrim);
        if (long) warn.push({ line: physicalLine, code: CODES.WARN.CARDID_LONG, message: `CardID length > 7` });
        outOld.push([prfCardNo, TotalAmount, curNorm, monthOut, SupportRegion, noteHQ]);
      }

      valid++;
    });

    const newCount = outNew.length; const oldCount = outOld.length; const warnings = warn.length; const errors = err.length;
    setMsgsErr(err); setMsgsWarn(warn); setCounts({ total, valid, newCount, oldCount, warnings, errors });

    if (valid === 0) { setStatus("Failed"); downloadErrorsCsv(err); return; }

    setStatus("Splitting"); setStageIdx(2); await sleep(STAGE_DELAYS.Splitting * DELAY_MULTIPLIER);
    const newChunks = chunk(outNew, 300); const oldChunks = chunk(outOld, 300);

    setStatus("Naming"); setStageIdx(3); await sleep(STAGE_DELAYS.Naming * DELAY_MULTIPLIER);
    const dateUTC = utcYYYYMMDD();

    const newFiles: { name: string; content: string }[] = [];
    const oldFiles: { name: string; content: string }[] = [];
    const { newNames, oldNames } = buildFileNames(newChunks.length, oldChunks.length, startSeq, dateUTC);
    for (let i = 0; i < newChunks.length; i++) {
      const content = csvOf(["Name", "Email", "Country", "Total Amount", "Currency", "Month", "SupportRegion", "Note"], newChunks[i]);
      newFiles.push({ name: newNames[i], content });
    }
    for (let i = 0; i < oldChunks.length; i++) {
      const content = csvOf(["PRF Card No", "TotalAmount", "Currency", "Month", "SupportRegion", "Note"], oldChunks[i]);
      oldFiles.push({ name: oldNames[i], content });
    }

    setStatus("Packaging"); setStageIdx(4); await sleep(STAGE_DELAYS.Packaging * DELAY_MULTIPLIER);

    const warningsCsv = csvOf(["line", "code", "message"], warn.map((m) => [String(m.line), m.code, m.message]));
    const errorsCsv = csvOf(["line", "code", "message"], err.map((m) => [String(m.line), m.code, m.message]));

    const zip = new JSZip(); const jid = jobId();
    for (const f of newFiles) zip.file(f.name, f.content);
    for (const f of oldFiles) zip.file(f.name, f.content);
    if (warn.length) zip.file("warnings.csv", warningsCsv);
    if (err.length) zip.file("errors.csv", errorsCsv);

    const width = startSeq.length;
    const manifest = {
      jobId: jid,
      dateUTC,
      startSeq,
      firstSeq: String(parseInt(startSeq, 10)).padStart(width, "0"),
      newFiles: newFiles.map((f) => f.name),
      oldFiles: oldFiles.map((f) => f.name),
      counts: { total, valid, new: newCount, old: oldCount, warnings, errors },
    };
    zip.file("manifest.json", JSON.stringify(manifest, null, 2));

    const blob = await zip.generateAsync({ type: "blob" });
    const zipName = `prf_bulk_${dateUTC}_${jid}.zip`;
    const finalBlob = blob && (blob as any).type ? blob : new Blob([blob], { type: "application/zip" });
    setZipBlob(finalBlob); setZipFileName(zipName);
    try { downloadBlob(finalBlob, zipName, { openFallback: true }); } catch {}

    const seqFirst = (newFiles[0]?.name ?? oldFiles[0]?.name)?.split("_")[0] ?? String(parseInt(startSeq, 10)).padStart(width, "0");
    const seqLast = (oldFiles[oldFiles.length - 1] ?? newFiles[newFiles.length - 1]).name.split("_")[0];

    setSummary({ newFiles: newFiles.map((f) => f.name), oldFiles: oldFiles.map((f) => f.name), dateUTC, jobId: jid, seqRange: `${seqFirst} - ${seqLast}`, zipName });
    setStatus("Complete"); setStageIdx(5);
  };

  const progressValue = useMemo(() => {
    switch (status) {
      case "Idle": return 0; case "Validating": return 15; case "Transforming": return 40; case "Splitting": return 60; case "Naming": return 75; case "Packaging": return 90; case "Complete": case "Failed": return 100;
    }
  }, [status]);

  const stageState = (i: number): "idle"|"active"|"done"|"fail" => {
    if (status === "Failed") { if (i < stageIdx) return "done"; if (i === stageIdx) return "fail"; return "idle"; }
    if (i < stageIdx) return "done"; if (i === stageIdx) return "active"; return "idle";
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="w-full border-b bg-white">
        <div className="mx-auto max-w-6xl px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-2xl bg-black text-white grid place-content-center font-bold">HF</div>
            <div className="font-semibold">Hope Fuel — PRF Bulk Import</div>
            <Badge variant="outline" className="ml-2">MVP</Badge>
          </div>
          <div className="text-xs text-gray-500">UTC: {utcYYYYMMDD()}</div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg"><Upload className="h-5 w-5" /> Upload PRF CSV & Start Sequence</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div
                className={`rounded-2xl border-2 border-dashed p-6 text-center ${dndActive ? "bg-gray-100" : "bg-white"}`}
                onDragOver={(e) => { e.preventDefault(); setDndActive(true); }}
                onDragLeave={() => setDndActive(false)}
                onDrop={(e) => {
                  e.preventDefault(); setDndActive(false);
                  const files = Array.from(e.dataTransfer.files).filter(f => isCsvFileName(f.name));
                  acceptCsvFile(files.length ? (Object.assign({ 0: files[0], length: 1 }) as unknown as FileList) : null);
                  if (!files.length) setUploadError("Only .csv files are supported.");
                }}
              >
                <div className="text-sm mb-2">Drag & drop <b>.csv</b> only, or choose a file</div>
                <Input key={fileInputKey} type="file" accept=".csv" onChange={(e) => acceptCsvFile(e.target.files)} />
                {csvFile && <div className="mt-2 text-xs text-gray-600">Selected: {csvFile.name}</div>}
                {uploadError && <div className="mt-2 text-sm text-rose-700">{uploadError}</div>}
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <Label className="text-sm">start_seq (≥ 3 digits; leading zeros preserved)</Label>
                  <Input placeholder="e.g., 0133" value={startSeq} onChange={(e) => setStartSeq(e.target.value.replace(/\D/g, ""))} />
                  {!startSeqValid && (<div className="text-xs text-rose-700 mt-1">Enter at least 3 digits</div>)}
                </div>
                <div className="flex items-end gap-2">
                  <Button onClick={handleReset} variant="ghost" className="gap-2"><RefreshCw className="h-4 w-4" /> Reset</Button>
                </div>
              </div>

              <Separator />

              <div className="flex items-center gap-3">
                <Button disabled={!canStart} onClick={startProcessing} className="gap-2"><FileCog className="h-4 w-4" /> Start Processing</Button>
              </div>

              <div className="pt-4">
                <Label className="text-sm mb-1 block">Progress</Label>
                <Progress value={progressValue} />
                <div className="mt-2 flex flex-wrap gap-2 text-xs">
                  <StageChip state={stageState(0)}>Validate</StageChip>
                  <StageChip state={stageState(1)}>Transform</StageChip>
                  <StageChip state={stageState(2)}>Split</StageChip>
                  <StageChip state={stageState(3)}>Name</StageChip>
                  <StageChip state={stageState(4)}>Package</StageChip>
                  <StageChip state={stageState(5)}>{status === "Failed" ? "Failed" : "Complete"}</StageChip>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg"><Info className="h-5 w-5" /> Live Summary</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="grid grid-cols-2 gap-2">
                <Stat label="Total Rows" value={counts.total} />
                <Stat label="Valid Rows" value={counts.valid} />
                <Stat label="New Members" value={counts.newCount} />
                <Stat label="Old Members" value={counts.oldCount} />
                <Stat label="Warnings" value={counts.warnings} />
                <Stat label="Errors" value={counts.errors} />
              </div>
              {status === "Complete" && summary && (
                <div className="rounded-xl border p-3 bg-gray-50">
                  <div className="font-medium mb-2">Completion</div>
                  <div className="grid grid-cols-2 gap-2">
                    <div><div className="text-gray-500">Date (UTC)</div><div>{summary.dateUTC}</div></div>
                    <div><div className="text-gray-500">Job ID</div><div>{summary.jobId}</div></div>
                    <div className="col-span-2"><div className="text-gray-500">Seq Range</div><div>{summary.seqRange}</div></div>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Badge variant="secondary" className="text-xs">New files: {summary.newFiles.length}</Badge>
                    <Badge variant="secondary" className="text-xs">Old files: {summary.oldFiles.length}</Badge>
                  </div>
                  <div className="mt-3 flex items-center gap-2">
                    <Button className="gap-2" onClick={() => zipBlob && downloadBlob(zipBlob, zipFileName, { openFallback: true })} disabled={!zipBlob}><Download className="h-4 w-4" /> Download ZIP</Button>
                    {zipFileName && <span className="text-xs text-gray-500">{zipFileName}</span>}
                    {zipBlob && (<Button variant="ghost" size="sm" className="gap-1" onClick={() => openBlobInNewTab(zipBlob)}>Open in new tab</Button>)}
                  </div>
                </div>
              )}
              {status === "Failed" && (
                <div className="rounded-xl border p-3 bg-red-50 text-red-800">
                  <div className="flex items-center gap-2 font-medium"><XCircle className="h-4 w-4"/> Job Failed</div>
                  <div className="text-xs mt-1">Header failure or 0 valid rows. An errors.csv was auto-downloaded. Fix input and retry.</div>
                  <div className="mt-2">
                    <Button size="sm" className="gap-2" onClick={() =>
                      downloadBlob(new Blob([csvOf(["line","code","message"], msgsErr.map((m) => [String(m.line), m.code, m.message]))], { type: "text/csv;charset=utf-8" }), `errors_${utcYYYYMMDD()}.csv`)
                    }>
                      <Download className="h-4 w-4" /> Download errors.csv
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="mt-6 grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2 text-base"><FileWarning className="h-5 w-5" /> Warnings ({msgsWarn.length})</CardTitle></CardHeader>
            <CardContent><MsgTable msgs={msgsWarn} variant="warn" /></CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2 text-base"><XCircle className="h-5 w-5" /> Errors ({msgsErr.length})</CardTitle></CardHeader>
            <CardContent><MsgTable msgs={msgsErr} variant="error" /></CardContent>
          </Card>
        </div>

        <div className="mt-8 text-xs text-gray-500">Only .csv uploads are allowed. Month comes from CSV. Country mapping is hard-coded.</div>
      </main>
    </div>
  );
}

function StageChip({ state, children }: { state: "idle"|"active"|"done"|"fail"; children: React.ReactNode }) {
  const variants: Variants = {
    idle: { scale: 1, opacity: 0.85 },
    active: { scale: [1, 1.05, 1], opacity: 1, transition: { repeat: Infinity, duration: 1.2 } },
    done: { scale: 1, opacity: 1 },
    fail: { x: [0, -4, 4, -3, 3, 0], transition: { duration: 0.6 } },
  };

  return (
    <motion.div
      className={`px-2 py-1 rounded-full border text-xs ${state === "active" ? "bg-black text-white border-black" : state === "done" ? "bg-white border-green-600 text-green-700" : state === "fail" ? "bg-white border-rose-600 text-rose-700" : "bg-white"}`}
      variants={variants}
      animate={state}
      transition={{ type: "spring", stiffness: 300, damping: 20 }}
      role="status"
    >
      {children}
    </motion.div>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (<div className="rounded-xl border p-3 bg-white"><div className="text-gray-500 text-xs">{label}</div><div className="text-lg font-semibold">{value}</div></div>);
}

function MsgTable({ msgs, variant }: { msgs: RowMsg[]; variant: "warn" | "error" }) {
  return (
    <div className="max-h-80 overflow-auto rounded-xl border bg-white">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-gray-50"><tr><th className="text-left p-2 w-16">Line</th><th className="text-left p-2 w-44">Code</th><th className="text-left p-2">Message</th></tr></thead>
        <tbody>
          {msgs.length === 0 ? (<tr><td colSpan={3} className="p-3 text-gray-400 text-center">No {variant === "warn" ? "warnings" : "errors"}</td></tr>) : (
            msgs.map((m, i) => (
              <tr key={i} className="border-t">
                <td className="p-2 text-gray-500">{m.line}</td>
                <td className="p-2"><span className={`px-2 py-1 rounded-full text-xs ${variant === "warn" ? "bg-amber-50 text-amber-800 border border-amber-200" : "bg-rose-50 text-rose-800 border border-rose-200"}`}>{m.code}</span></td>
                <td className="p-2">{m.message}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

// -------------------------- Self-tests (manual) --------------------------
/** Run in browser console: window.__runMvpTests__() */
function __runMvpTests__() {
  const results: { name: string; ok: boolean; detail?: string }[] = [];
  const t = (name: string, fn: () => void) => { try { fn(); results.push({ name, ok: true }); } catch (e: any) { results.push({ name, ok: false, detail: e?.message }); } };
  const eq = (a: any, b: any) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${JSON.stringify(a)} !== ${JSON.stringify(b)}`); };
  const ok = (v: any) => { if (!v) throw new Error(`expected truthy, got ${v}`); };
  const no = (v: any) => { if (v) throw new Error(`expected falsy, got ${v}`); };

  // Month
  t("month: accepts 12", () => ok(isValidMonth("12")));
  t("month: rejects 13", () => no(isValidMonth("13")));

  // CSV gating
  t("csv filename ok", () => ok(isCsvFileName("data.csv")));
  t("csv filename bad", () => no(isCsvFileName("data.xlsx")));

  // Filenames (PRD rules — no chunk suffix)
  t("filenames: single new + single old", () => {
    const { newNames, oldNames } = buildFileNames(1, 1, "098", "20250830");
    eq(newNames, ["098_prf_bulk_import_20250830.csv"]);
    eq(oldNames, ["099_extension_prf_bulk_import_20250830.csv"]);
  });
  t("filenames: two new + one old", () => {
    const { newNames, oldNames } = buildFileNames(2, 1, "098", "20250830");
    eq(newNames, ["098_prf_bulk_import_20250830.csv","099_prf_bulk_import_20250830.csv"]);
    eq(oldNames, ["100_extension_prf_bulk_import_20250830.csv"]);
  });

  console.table(results);
  const passed = results.filter(r => r.ok).length; const failed = results.length - passed;
  console.log(`MVP tests: ${passed} passed, ${failed} failed`);
  return { passed, failed, results };
}

if (typeof window !== "undefined") {
  // @ts-ignore
  (window as any).__runMvpTests__ = __runMvpTests__;
}
