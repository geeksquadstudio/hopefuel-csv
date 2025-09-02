import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
// File: src/App.tsx
// Hope Fuel PRF Bulk Import & Member Categorization – MVP (React + TS)
// Month comes from CSV; Country mapping hard-coded; Only .csv accepted.
import { useMemo, useState } from "react";
import { motion } from "framer-motion";
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
    "Name", "Email", "Country", "CardID", "TotalAmount", "Currency", "Month", "SupportRegion", "HQID", "TransactionDate", "PaymentCheckDate", "FormFillingPerson", "Note",
];
const CANONICAL_WITH_MONTH = [...INPUT_HEADERS];
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
};
const COUNTRY_MAP = { Myanmar: "MM", Thailand: "TH" };
const MAX_BYTES = 25 * 1024 * 1024; // 25MB
const MAX_ROWS = 50000; // data rows (excluding header)
// -------------------------- Utility helpers --------------------------
const normHeader = (h) => h.toLowerCase().replace(/\s+|_/g, "");
const utcYYYYMMDD = () => { const d = new Date(); return d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2, "0") + String(d.getUTCDate()).padStart(2, "0"); };
const isValidEmail = (s) => /^(?!.{255,})[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(s.trim());
const normalizeCurrency = (s) => s.trim().toUpperCase();
const isValidCurrency = (s) => /^[A-Z]{3}$/.test(normalizeCurrency(s));
const isValidAmount = (s) => /^\d{1,18}(\.\d{1,2})?$/.test(s.trim());
const isValidISODate = (s) => !Number.isNaN(Date.parse(s.trim()));
const normalizeMonth = (s) => String(s ?? '').trim();
const isValidMonth = (s) => /^(?:[1-9]|1[0-2])$/.test(normalizeMonth(s));
const trimTo = (arr, n) => Array.from({ length: n }, (_, i) => (arr[i] ?? "").trim());
const dupKeyOf = (arr) => arr.map((v) => (v ?? "").trim()).join("\u001F");
const mapCountry = (name) => COUNTRY_MAP[name.trim()] ?? "ZZ";
const buildNewCardId = (digits) => digits.length > 7 ? { value: `PRF-${digits}`, long: true } : { value: `PRF-${digits.padStart(7, "0")}`, long: false };
const csvOf = (header, rows) => Papa.unparse([header, ...rows], { quotes: true, newline: "\r\n" });
function downloadBlob(blob, filename, opts) {
    try {
        saveAs(blob, filename);
        return;
    }
    catch { }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    if (opts?.openFallback) {
        setTimeout(() => { try {
            window.open(url, "_blank", "noopener");
        }
        catch { } }, 150);
    }
    setTimeout(() => { try {
        document.body.removeChild(a);
    }
    catch { } ; URL.revokeObjectURL(url); }, 1000);
}
function openBlobInNewTab(blob) {
    const url = URL.createObjectURL(blob);
    try {
        window.open(url, "_blank", "noopener");
    }
    finally {
        setTimeout(() => URL.revokeObjectURL(url), 30000);
    }
}
const chunk = (arr, n = 300) => { const out = []; for (let i = 0; i < arr.length; i += n)
    out.push(arr.slice(i, i + n)); return out; };
const jobId = () => "J-" + utcYYYYMMDD() + "-" + Math.random().toString(36).slice(2, 8).toUpperCase();
// --- Filename helpers (PRD exact shapes — NO chunk suffix) ---
const makeSeq = (startSeq) => { const width = startSeq.length; let n = parseInt(startSeq, 10); return () => String(n++).padStart(width, "0"); };
const newFileName = (seq, dateUTC, _idx, _total) => `${seq}_prf_bulk_import_${dateUTC}.csv`;
const oldFileName = (seq, dateUTC, _idx, _total) => `${seq}_extension_prf_bulk_import_${dateUTC}.csv`;
function buildFileNames(newCount, oldCount, startSeq, dateUTC) {
    const nextSeq = makeSeq(startSeq);
    const newNames = Array.from({ length: newCount }, (_, i) => newFileName(nextSeq(), dateUTC, i, newCount));
    const oldNames = Array.from({ length: oldCount }, (_, i) => oldFileName(nextSeq(), dateUTC, i, oldCount));
    return { newNames, oldNames };
}
// Simulated stage delays for richer UX
const STAGE_DELAYS = { Validating: 800, Transforming: 1000, Splitting: 800, Naming: 800, Packaging: 1000 };
const DELAY_MULTIPLIER = 1.6;
const sleep = (ms) => new Promise(res => setTimeout(res, ms));
// Strict CSV gating
const isCsvFileName = (name) => /\.csv$/i.test(name.trim());
const isCsvMime = (type) => type === "text/csv" || type === "application/vnd.ms-excel" || type === "";
const downloadErrorsCsv = (rows, name = `errors_${utcYYYYMMDD()}.csv`) => {
    const csv = csvOf(["line", "code", "message"], rows.map((m) => [String(m.line), m.code, m.message]));
    downloadBlob(new Blob([csv], { type: "text/csv;charset=utf-8" }), name);
};
// -------------------------- Component --------------------------
export default function App() {
    const [csvFile, setCsvFile] = useState(null);
    const [startSeq, setStartSeq] = useState("");
    const [status, setStatus] = useState("Idle");
    const [msgsErr, setMsgsErr] = useState([]);
    const [msgsWarn, setMsgsWarn] = useState([]);
    const [counts, setCounts] = useState({ total: 0, valid: 0, newCount: 0, oldCount: 0, warnings: 0, errors: 0 });
    const [summary, setSummary] = useState(null);
    const [uploadError, setUploadError] = useState("");
    const [dndActive, setDndActive] = useState(false);
    const [zipBlob, setZipBlob] = useState(null);
    const [zipFileName, setZipFileName] = useState("");
    const [fileInputKey, setFileInputKey] = useState(0);
    const [stageIdx, setStageIdx] = useState(-1);
    const startSeqValid = useMemo(() => /^\d{3,}$/.test(startSeq), [startSeq]);
    const canStart = !!csvFile && startSeqValid && !uploadError && status !== "Validating" && status !== "Packaging";
    const handleReset = () => {
        setStatus("Idle");
        setMsgsErr([]);
        setMsgsWarn([]);
        setCounts({ total: 0, valid: 0, newCount: 0, oldCount: 0, warnings: 0, errors: 0 });
        setSummary(null);
        setUploadError("");
        setCsvFile(null);
        setStartSeq("");
        setFileInputKey(k => k + 1);
        setZipBlob(null);
        setZipFileName("");
        setStageIdx(-1);
    };
    const readFileText = (f) => new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error);
        reader.onabort = () => reject(new Error("Aborted"));
        reader.onload = () => resolve(String(reader.result ?? "").replace(/^\uFEFF/, ""));
        reader.readAsText(f, "utf-8");
    });
    const acceptCsvFile = (files) => {
        if (!files || files.length === 0)
            return;
        if (files.length > 1) {
            setUploadError("Upload one CSV at a time");
            setCsvFile(null);
            return;
        }
        const f = files[0];
        if (!isCsvFileName(f.name) || !isCsvMime(f.type)) {
            setUploadError("Only .csv files are supported.");
            setCsvFile(null);
            return;
        }
        if (f.size > MAX_BYTES) {
            setUploadError("File exceeds limits (25MB/50k rows)");
            setCsvFile(null);
            return;
        }
        setUploadError("");
        setCsvFile(f);
    };
    const startProcessing = async () => {
        if (!csvFile || !startSeqValid)
            return;
        setStatus("Validating");
        setStageIdx(0);
        setMsgsErr([]);
        setMsgsWarn([]);
        setCounts({ total: 0, valid: 0, newCount: 0, oldCount: 0, warnings: 0, errors: 0 });
        setSummary(null);
        await sleep(STAGE_DELAYS.Validating * DELAY_MULTIPLIER);
        const csvText = await readFileText(csvFile);
        const parsed = Papa.parse(csvText, { skipEmptyLines: true });
        if (parsed.errors?.length) {
            const errs = [{ line: 1, code: CODES.ERR.ROW_COLS, message: `CSV parse error: ${parsed.errors[0].message}` }];
            setMsgsErr(errs);
            setStatus("Failed");
            downloadErrorsCsv(errs);
            return;
        }
        const rowsRaw = parsed.data;
        if (!rowsRaw.length) {
            const errs = [{ line: 1, code: CODES.ERR.HEADERS_MISSING, message: "Empty file or missing header" }];
            setMsgsErr(errs);
            setStatus("Failed");
            downloadErrorsCsv(errs);
            return;
        }
        const header = (rowsRaw[0] ?? []).map((h) => String(h ?? ""));
        const body = rowsRaw.slice(1);
        const bodyLens = body.map((r) => r.length);
        if (body.length > MAX_ROWS) {
            setUploadError("File exceeds limits (25MB/50k rows)");
            setStatus("Idle");
            return;
        }
        const normIncoming = header.map(normHeader);
        const normRequired = INPUT_HEADERS.map(normHeader);
        const normAllowed = [...normRequired];
        const missing = [];
        const extra = [];
        const mapIdx = [];
        for (let i = 0; i < CANONICAL_WITH_MONTH.length; i++) {
            const idx = normIncoming.indexOf(normHeader(CANONICAL_WITH_MONTH[i]));
            mapIdx.push(idx);
        }
        for (let i = 0; i < normRequired.length; i++) {
            const idx = normIncoming.indexOf(normRequired[i]);
            if (idx === -1)
                missing.push(INPUT_HEADERS[i]);
        }
        for (let i = 0; i < normIncoming.length; i++)
            if (!normAllowed.includes(normIncoming[i]))
                extra.push(header[i] ?? `#${i + 1}`);
        if (missing.length || extra.length) {
            const errs = [];
            if (missing.length)
                errs.push({ line: 1, code: CODES.ERR.HEADERS_MISSING, message: `Missing headers: ${missing.join(", ")}` });
            if (extra.length)
                errs.push({ line: 1, code: CODES.ERR.HEADERS_EXTRA, message: `Extra headers: ${extra.join(", ")}` });
            setMsgsErr(errs);
            setStatus("Failed");
            downloadErrorsCsv(errs);
            return;
        }
        const reordered = body.map((r) => mapIdx.map((idx) => (idx >= 0 ? (r[idx] ?? "") : "")));
        if (header.some((_, i) => normHeader(header[i] ?? "") !== normHeader(INPUT_HEADERS[i] ?? header[i] ?? ""))) {
            setMsgsWarn((prev) => [...prev, { line: 1, code: CODES.WARN.HEADERS_REORDERED, message: "Headers auto-reordered to canonical order" }]);
        }
        setStatus("Transforming");
        setStageIdx(1);
        await sleep(STAGE_DELAYS.Transforming * DELAY_MULTIPLIER);
        const seen = new Set();
        const outNew = [];
        const outOld = [];
        const warn = [];
        const err = [];
        let total = 0;
        let valid = 0;
        reordered.forEach((r, idx) => {
            const physicalLine = idx + 2;
            total++;
            if (bodyLens[idx] !== header.length) {
                err.push({ line: physicalLine, code: CODES.ERR.ROW_COLS, message: `Expected ${header.length} columns, got ${bodyLens[idx]}` });
                return;
            }
            const arr = trimTo(r, CANONICAL_WITH_MONTH.length);
            const [Name, Email, Country, CardID, TotalAmount, Currency, MonthFromCsv, SupportRegion, HQID, TransactionDate, PaymentCheckDate, FormFillingPerson, Note] = arr;
            const key = dupKeyOf(arr);
            if (seen.has(key)) {
                warn.push({ line: physicalLine, code: CODES.WARN.DUP_EXACT, message: "Exact duplicate dropped" });
                return;
            }
            seen.add(key);
            if (!Name || Name.length > 200) {
                err.push({ line: physicalLine, code: CODES.ERR.ROW_COLS, message: "Invalid Name length" });
                return;
            }
            if (!isValidEmail(Email)) {
                err.push({ line: physicalLine, code: CODES.ERR.EMAIL, message: `Invalid email: ${Email}` });
                return;
            }
            if (!isValidAmount(TotalAmount)) {
                err.push({ line: physicalLine, code: CODES.ERR.AMOUNT_NUM, message: `Invalid amount: ${TotalAmount}` });
                return;
            }
            if (parseFloat(TotalAmount) <= 0) {
                err.push({ line: physicalLine, code: CODES.ERR.AMOUNT_POS, message: `Amount must be > 0` });
                return;
            }
            const curNorm = normalizeCurrency(Currency);
            if (!isValidCurrency(curNorm)) {
                err.push({ line: physicalLine, code: CODES.ERR.CURR_CODE, message: `Invalid currency: ${Currency}` });
                return;
            }
            const monthOut = normalizeMonth(MonthFromCsv);
            if (!isValidMonth(monthOut)) {
                err.push({ line: physicalLine, code: CODES.ERR.ROW_COLS, message: `Invalid Month: ${MonthFromCsv}` });
                return;
            }
            if (!isValidISODate(TransactionDate) || !isValidISODate(PaymentCheckDate)) {
                err.push({ line: physicalLine, code: CODES.ERR.ROW_COLS, message: `Invalid dates` });
                return;
            }
            const cardTrim = CardID.trim();
            const isNew = cardTrim === "";
            if (!isNew) {
                if (!/^\d+$/.test(cardTrim)) {
                    err.push({ line: physicalLine, code: CODES.ERR.CARDID_NONNUM, message: `CardID must be digits` });
                    return;
                }
                if (cardTrim === "0") {
                    err.push({ line: physicalLine, code: CODES.ERR.CARDID_ZERO, message: `CardID cannot be zero` });
                    return;
                }
            }
            const noteHQ = `PRFHQ-${HQID.trim()}`;
            if (/[^0-9]/.test(HQID.trim()))
                warn.push({ line: physicalLine, code: CODES.WARN.HQID_NONNUM, message: `HQID contains non-digits` });
            const mappedCountry = mapCountry(Country);
            if (mappedCountry === "ZZ")
                warn.push({ line: physicalLine, code: CODES.WARN.COUNTRY_UNMAPPED, message: `Country '${Country}' unmapped; set 'ZZ'` });
            if (isNew) {
                outNew.push([Name, Email, mappedCountry, TotalAmount, curNorm, monthOut, SupportRegion, noteHQ]);
            }
            else {
                const { value: prfCardNo, long } = buildNewCardId(cardTrim);
                if (long)
                    warn.push({ line: physicalLine, code: CODES.WARN.CARDID_LONG, message: `CardID length > 7` });
                outOld.push([prfCardNo, TotalAmount, curNorm, monthOut, SupportRegion, noteHQ]);
            }
            valid++;
        });
        const newCount = outNew.length;
        const oldCount = outOld.length;
        const warnings = warn.length;
        const errors = err.length;
        setMsgsErr(err);
        setMsgsWarn(warn);
        setCounts({ total, valid, newCount, oldCount, warnings, errors });
        if (valid === 0) {
            setStatus("Failed");
            downloadErrorsCsv(err);
            return;
        }
        setStatus("Splitting");
        setStageIdx(2);
        await sleep(STAGE_DELAYS.Splitting * DELAY_MULTIPLIER);
        const newChunks = chunk(outNew, 300);
        const oldChunks = chunk(outOld, 300);
        setStatus("Naming");
        setStageIdx(3);
        await sleep(STAGE_DELAYS.Naming * DELAY_MULTIPLIER);
        const dateUTC = utcYYYYMMDD();
        const newFiles = [];
        const oldFiles = [];
        const { newNames, oldNames } = buildFileNames(newChunks.length, oldChunks.length, startSeq, dateUTC);
        for (let i = 0; i < newChunks.length; i++) {
            const content = csvOf(["Name", "Email", "Country", "Total Amount", "Currency", "Month", "SupportRegion", "Note"], newChunks[i]);
            newFiles.push({ name: newNames[i], content });
        }
        for (let i = 0; i < oldChunks.length; i++) {
            const content = csvOf(["PRF Card No", "TotalAmount", "Currency", "Month", "SupportRegion", "Note"], oldChunks[i]);
            oldFiles.push({ name: oldNames[i], content });
        }
        setStatus("Packaging");
        setStageIdx(4);
        await sleep(STAGE_DELAYS.Packaging * DELAY_MULTIPLIER);
        const warningsCsv = csvOf(["line", "code", "message"], warn.map((m) => [String(m.line), m.code, m.message]));
        const errorsCsv = csvOf(["line", "code", "message"], err.map((m) => [String(m.line), m.code, m.message]));
        const zip = new JSZip();
        const jid = jobId();
        for (const f of newFiles)
            zip.file(f.name, f.content);
        for (const f of oldFiles)
            zip.file(f.name, f.content);
        if (warn.length)
            zip.file("warnings.csv", warningsCsv);
        if (err.length)
            zip.file("errors.csv", errorsCsv);
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
        const finalBlob = blob && blob.type ? blob : new Blob([blob], { type: "application/zip" });
        setZipBlob(finalBlob);
        setZipFileName(zipName);
        try {
            downloadBlob(finalBlob, zipName, { openFallback: true });
        }
        catch { }
        const seqFirst = (newFiles[0]?.name ?? oldFiles[0]?.name)?.split("_")[0] ?? String(parseInt(startSeq, 10)).padStart(width, "0");
        const seqLast = (oldFiles[oldFiles.length - 1] ?? newFiles[newFiles.length - 1]).name.split("_")[0];
        setSummary({ newFiles: newFiles.map((f) => f.name), oldFiles: oldFiles.map((f) => f.name), dateUTC, jobId: jid, seqRange: `${seqFirst} - ${seqLast}`, zipName });
        setStatus("Complete");
        setStageIdx(5);
    };
    const progressValue = useMemo(() => {
        switch (status) {
            case "Idle": return 0;
            case "Validating": return 15;
            case "Transforming": return 40;
            case "Splitting": return 60;
            case "Naming": return 75;
            case "Packaging": return 90;
            case "Complete":
            case "Failed": return 100;
        }
    }, [status]);
    const stageState = (i) => {
        if (status === "Failed") {
            if (i < stageIdx)
                return "done";
            if (i === stageIdx)
                return "fail";
            return "idle";
        }
        if (i < stageIdx)
            return "done";
        if (i === stageIdx)
            return "active";
        return "idle";
    };
    return (_jsxs("div", { className: "min-h-screen bg-gray-50", children: [_jsx("header", { className: "w-full border-b bg-white", children: _jsxs("div", { className: "mx-auto max-w-6xl px-4 py-4 flex items-center justify-between", children: [_jsxs("div", { className: "flex items-center gap-3", children: [_jsx("div", { className: "h-9 w-9 rounded-2xl bg-black text-white grid place-content-center font-bold", children: "HF" }), _jsx("div", { className: "font-semibold", children: "Hope Fuel \u2014 PRF Bulk Import" }), _jsx(Badge, { variant: "outline", className: "ml-2", children: "MVP" })] }), _jsxs("div", { className: "text-xs text-gray-500", children: ["UTC: ", utcYYYYMMDD()] })] }) }), _jsxs("main", { className: "mx-auto max-w-6xl px-4 py-6", children: [_jsxs("div", { className: "grid grid-cols-1 lg:grid-cols-3 gap-6", children: [_jsxs(Card, { className: "lg:col-span-2", children: [_jsx(CardHeader, { children: _jsxs(CardTitle, { className: "flex items-center gap-2 text-lg", children: [_jsx(Upload, { className: "h-5 w-5" }), " Upload PRF CSV & Start Sequence"] }) }), _jsxs(CardContent, { className: "space-y-4", children: [_jsxs("div", { className: `rounded-2xl border-2 border-dashed p-6 text-center ${dndActive ? "bg-gray-100" : "bg-white"}`, onDragOver: (e) => { e.preventDefault(); setDndActive(true); }, onDragLeave: () => setDndActive(false), onDrop: (e) => {
                                                    e.preventDefault();
                                                    setDndActive(false);
                                                    const files = Array.from(e.dataTransfer.files).filter(f => isCsvFileName(f.name));
                                                    acceptCsvFile(files.length ? Object.assign({ 0: files[0], length: 1 }) : null);
                                                    if (!files.length)
                                                        setUploadError("Only .csv files are supported.");
                                                }, children: [_jsxs("div", { className: "text-sm mb-2", children: ["Drag & drop ", _jsx("b", { children: ".csv" }), " only, or choose a file"] }), _jsx(Input, { type: "file", accept: ".csv", onChange: (e) => acceptCsvFile(e.target.files) }, fileInputKey), csvFile && _jsxs("div", { className: "mt-2 text-xs text-gray-600", children: ["Selected: ", csvFile.name] }), uploadError && _jsx("div", { className: "mt-2 text-sm text-rose-700", children: uploadError })] }), _jsxs("div", { className: "grid grid-cols-1 md:grid-cols-2 gap-4", children: [_jsxs("div", { children: [_jsx(Label, { className: "text-sm", children: "start_seq (\u2265 3 digits; leading zeros preserved)" }), _jsx(Input, { placeholder: "e.g., 0133", value: startSeq, onChange: (e) => setStartSeq(e.target.value.replace(/\D/g, "")) }), !startSeqValid && (_jsx("div", { className: "text-xs text-rose-700 mt-1", children: "Enter at least 3 digits" }))] }), _jsx("div", { className: "flex items-end gap-2", children: _jsxs(Button, { onClick: handleReset, variant: "ghost", className: "gap-2", children: [_jsx(RefreshCw, { className: "h-4 w-4" }), " Reset"] }) })] }), _jsx(Separator, {}), _jsx("div", { className: "flex items-center gap-3", children: _jsxs(Button, { disabled: !canStart, onClick: startProcessing, className: "gap-2", children: [_jsx(FileCog, { className: "h-4 w-4" }), " Start Processing"] }) }), _jsxs("div", { className: "pt-4", children: [_jsx(Label, { className: "text-sm mb-1 block", children: "Progress" }), _jsx(Progress, { value: progressValue }), _jsxs("div", { className: "mt-2 flex flex-wrap gap-2 text-xs", children: [_jsx(StageChip, { state: stageState(0), children: "Validate" }), _jsx(StageChip, { state: stageState(1), children: "Transform" }), _jsx(StageChip, { state: stageState(2), children: "Split" }), _jsx(StageChip, { state: stageState(3), children: "Name" }), _jsx(StageChip, { state: stageState(4), children: "Package" }), _jsx(StageChip, { state: stageState(5), children: status === "Failed" ? "Failed" : "Complete" })] })] })] })] }), _jsxs(Card, { children: [_jsx(CardHeader, { children: _jsxs(CardTitle, { className: "flex items-center gap-2 text-lg", children: [_jsx(Info, { className: "h-5 w-5" }), " Live Summary"] }) }), _jsxs(CardContent, { className: "space-y-3 text-sm", children: [_jsxs("div", { className: "grid grid-cols-2 gap-2", children: [_jsx(Stat, { label: "Total Rows", value: counts.total }), _jsx(Stat, { label: "Valid Rows", value: counts.valid }), _jsx(Stat, { label: "New Members", value: counts.newCount }), _jsx(Stat, { label: "Old Members", value: counts.oldCount }), _jsx(Stat, { label: "Warnings", value: counts.warnings }), _jsx(Stat, { label: "Errors", value: counts.errors })] }), status === "Complete" && summary && (_jsxs("div", { className: "rounded-xl border p-3 bg-gray-50", children: [_jsx("div", { className: "font-medium mb-2", children: "Completion" }), _jsxs("div", { className: "grid grid-cols-2 gap-2", children: [_jsxs("div", { children: [_jsx("div", { className: "text-gray-500", children: "Date (UTC)" }), _jsx("div", { children: summary.dateUTC })] }), _jsxs("div", { children: [_jsx("div", { className: "text-gray-500", children: "Job ID" }), _jsx("div", { children: summary.jobId })] }), _jsxs("div", { className: "col-span-2", children: [_jsx("div", { className: "text-gray-500", children: "Seq Range" }), _jsx("div", { children: summary.seqRange })] })] }), _jsxs("div", { className: "mt-2 flex flex-wrap gap-2", children: [_jsxs(Badge, { variant: "secondary", className: "text-xs", children: ["New files: ", summary.newFiles.length] }), _jsxs(Badge, { variant: "secondary", className: "text-xs", children: ["Old files: ", summary.oldFiles.length] })] }), _jsxs("div", { className: "mt-3 flex items-center gap-2", children: [_jsxs(Button, { className: "gap-2", onClick: () => zipBlob && downloadBlob(zipBlob, zipFileName, { openFallback: true }), disabled: !zipBlob, children: [_jsx(Download, { className: "h-4 w-4" }), " Download ZIP"] }), zipFileName && _jsx("span", { className: "text-xs text-gray-500", children: zipFileName }), zipBlob && (_jsx(Button, { variant: "ghost", size: "sm", className: "gap-1", onClick: () => openBlobInNewTab(zipBlob), children: "Open in new tab" }))] })] })), status === "Failed" && (_jsxs("div", { className: "rounded-xl border p-3 bg-red-50 text-red-800", children: [_jsxs("div", { className: "flex items-center gap-2 font-medium", children: [_jsx(XCircle, { className: "h-4 w-4" }), " Job Failed"] }), _jsx("div", { className: "text-xs mt-1", children: "Header failure or 0 valid rows. An errors.csv was auto-downloaded. Fix input and retry." }), _jsx("div", { className: "mt-2", children: _jsxs(Button, { size: "sm", className: "gap-2", onClick: () => downloadBlob(new Blob([csvOf(["line", "code", "message"], msgsErr.map((m) => [String(m.line), m.code, m.message]))], { type: "text/csv;charset=utf-8" }), `errors_${utcYYYYMMDD()}.csv`), children: [_jsx(Download, { className: "h-4 w-4" }), " Download errors.csv"] }) })] }))] })] })] }), _jsxs("div", { className: "mt-6 grid grid-cols-1 lg:grid-cols-2 gap-6", children: [_jsxs(Card, { children: [_jsx(CardHeader, { children: _jsxs(CardTitle, { className: "flex items-center gap-2 text-base", children: [_jsx(FileWarning, { className: "h-5 w-5" }), " Warnings (", msgsWarn.length, ")"] }) }), _jsx(CardContent, { children: _jsx(MsgTable, { msgs: msgsWarn, variant: "warn" }) })] }), _jsxs(Card, { children: [_jsx(CardHeader, { children: _jsxs(CardTitle, { className: "flex items-center gap-2 text-base", children: [_jsx(XCircle, { className: "h-5 w-5" }), " Errors (", msgsErr.length, ")"] }) }), _jsx(CardContent, { children: _jsx(MsgTable, { msgs: msgsErr, variant: "error" }) })] })] }), _jsx("div", { className: "mt-8 text-xs text-gray-500", children: "Only .csv uploads are allowed. Month comes from CSV. Country mapping is hard-coded." })] })] }));
}
function StageChip({ state, children }) {
    const variants = {
        idle: { scale: 1, opacity: 0.85 },
        active: { scale: [1, 1.05, 1], opacity: 1, transition: { repeat: Infinity, duration: 1.2 } },
        done: { scale: 1, opacity: 1 },
        fail: { x: [0, -4, 4, -3, 3, 0], transition: { duration: 0.6 } },
    };
    return (_jsx(motion.div, { className: `px-2 py-1 rounded-full border text-xs ${state === "active" ? "bg-black text-white border-black" : state === "done" ? "bg-white border-green-600 text-green-700" : state === "fail" ? "bg-white border-rose-600 text-rose-700" : "bg-white"}`, variants: variants, animate: state, transition: { type: "spring", stiffness: 300, damping: 20 }, role: "status", children: children }));
}
function Stat({ label, value }) {
    return (_jsxs("div", { className: "rounded-xl border p-3 bg-white", children: [_jsx("div", { className: "text-gray-500 text-xs", children: label }), _jsx("div", { className: "text-lg font-semibold", children: value })] }));
}
function MsgTable({ msgs, variant }) {
    return (_jsx("div", { className: "max-h-80 overflow-auto rounded-xl border bg-white", children: _jsxs("table", { className: "w-full text-sm", children: [_jsx("thead", { className: "sticky top-0 bg-gray-50", children: _jsxs("tr", { children: [_jsx("th", { className: "text-left p-2 w-16", children: "Line" }), _jsx("th", { className: "text-left p-2 w-44", children: "Code" }), _jsx("th", { className: "text-left p-2", children: "Message" })] }) }), _jsx("tbody", { children: msgs.length === 0 ? (_jsx("tr", { children: _jsxs("td", { colSpan: 3, className: "p-3 text-gray-400 text-center", children: ["No ", variant === "warn" ? "warnings" : "errors"] }) })) : (msgs.map((m, i) => (_jsxs("tr", { className: "border-t", children: [_jsx("td", { className: "p-2 text-gray-500", children: m.line }), _jsx("td", { className: "p-2", children: _jsx("span", { className: `px-2 py-1 rounded-full text-xs ${variant === "warn" ? "bg-amber-50 text-amber-800 border border-amber-200" : "bg-rose-50 text-rose-800 border border-rose-200"}`, children: m.code }) }), _jsx("td", { className: "p-2", children: m.message })] }, i)))) })] }) }));
}
// -------------------------- Self-tests (manual) --------------------------
/** Run in browser console: window.__runMvpTests__() */
function __runMvpTests__() {
    const results = [];
    const t = (name, fn) => { try {
        fn();
        results.push({ name, ok: true });
    }
    catch (e) {
        results.push({ name, ok: false, detail: e?.message });
    } };
    const eq = (a, b) => { if (JSON.stringify(a) !== JSON.stringify(b))
        throw new Error(`${JSON.stringify(a)} !== ${JSON.stringify(b)}`); };
    const ok = (v) => { if (!v)
        throw new Error(`expected truthy, got ${v}`); };
    const no = (v) => { if (v)
        throw new Error(`expected falsy, got ${v}`); };
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
        eq(newNames, ["098_prf_bulk_import_20250830.csv", "099_prf_bulk_import_20250830.csv"]);
        eq(oldNames, ["100_extension_prf_bulk_import_20250830.csv"]);
    });
    console.table(results);
    const passed = results.filter(r => r.ok).length;
    const failed = results.length - passed;
    console.log(`MVP tests: ${passed} passed, ${failed} failed`);
    return { passed, failed, results };
}
if (typeof window !== "undefined") {
    // @ts-ignore
    window.__runMvpTests__ = __runMvpTests__;
}
