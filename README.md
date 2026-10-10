# DREAMGET AI — APPLY TO JOBS IN ONE CLICK

**Tagline:** *Find your job. Match your skills. Shape your future.*

DREAMGET AI is an AI-powered job search and application platform designed for students, freshers, and early-career job seekers. It eliminates manual form-filling and fragmented job tracking while keeping users 100% in control through an **explicit approval-based workflow**.

---

## 🚀 Key Features

1. **AI Resume Analyzer (Feature 1):**
   - Upload PDF or TXT resumes.
   - Extracts contact info, technical skills, soft skills, education, experience, projects, certifications, strengths, and areas for improvement using Google Gemini.
   - Full in-place editing before saving to persistent storage.
   - Generates tailored suggestions for improving the resume for a selected job without inventing qualifications.

2. **Multi-Website Job Search (Feature 2):**
   - Aggregated job feed from multiple authorized sources (TechCareers API, RemoteFirst Board, CampusHire Feeds, StartupJobs Hub).
   - Real-time search across titles, descriptions, and required skills.
   - Filters for location, remote workplace, experience level, employment type, and provider source.
   - Bookmarking and duplicate job detection.

3. **Smart Job Matching (Feature 3):**
   - Transparent 0 to 100 compatibility scoring engine.
   - Configurable weight sliders (Skills 45%, Experience 25%, Education 15%, Title 10%, Location 5%).
   - Displays matching skills, missing skills, rationale bullets, and next steps.

4. **Approval-Based 1-Click Application (Feature 4):**
   - 1-Click preparation: gathers candidate profile, selects resume version, drafts tailored cover letter, and pre-fills screening answers strictly based on verified data.
   - Unified review modal showing employer, role, destination gateway, and answers.
   - **Mandatory User Consent & Digital Signature:** applications are never submitted without explicit user authorization.
   - Direct API submission with provider confirmation receipts (e.g. `NP-APP-2026-09148`) or guided external links for manual portals.

5. **Smart Job Alerts (Feature 5):**
   - Create saved search alerts with custom score thresholds (e.g., ≥ 75%).
   - Automated background feed scanning with instant in-app notifications.
   - Pause, resume, and delete alerts with zero duplicate notifications.

6. **Skill Gap Roadmap (Feature 6):**
   - Benchmarks verified resume skills against target roles (e.g. Full-Stack Engineer, Backend Specialist).
   - Distinguishes Required, Preferred, and Inferred skills with priority levels.
   - Weekly milestones, recommended portfolio projects, and interactive checklist progress tracking.
   - Recalibrate roadmap on demand via Google Gemini.

7. **Application Analytics & Funnel (Feature 7):**
   - Full funnel metrics: Saved jobs, Approved, Delivered, Interviews, Offers, Rejections.
   - Transparent response rate and interview rate formulas.
   - Weekly submission velocity and category distribution SVG charts.
   - Instant CSV export of complete application audit history.

---

## 🛠️ Architecture & Technology Stack

- **Frontend:** React 19, TypeScript, Tailwind CSS v4, Lucide Icons, Plus Jakarta Sans typography.
- **AI Engine:** Google Gemini API (`gemini-3.8-flash` via `@google/genai`).
- **Live Sandbox Runtime:** Express full-stack server mounted with Vite middleware on port 3000 (`server.ts`).
- **Companion Python Backend:** Complete FastAPI + SQLAlchemy + SQLite codebase located in `/backend` (`main.py`, `models.py`, `schemas.py`, `services/`, `tests/`).
- **Storage:** Persistent JSON database (`data/db.json`) in Node and SQLite (`backend/dreamget.db`) in Python.

---

## 💻 Running the Project

### A. Live Interactive App (Current Environment)
The interactive application is running live via:
```bash
npm run dev
```
Open the development app URL to explore all views and features immediately.

### B. Running the Python FastAPI Backend (Local Machine)
```bash
cd backend
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate
pip install -r requirements.txt
export GEMINI_API_KEY="your-api-key"
uvicorn backend.main:app --reload --port 8000
```
Open `http://localhost:8000/docs` for the interactive Swagger OpenAPI docs.

### C. Running Tests
- **Frontend / Full-Stack linting:** `npm run lint`
- **Python backend test suite:** `pytest backend/tests/test_api.py -v`

---

## 🔒 Security & Privacy
- **Zero API Key Exposure:** `GEMINI_API_KEY` is loaded exclusively from server-side environment variables.
- **Zero Hallucination Guarantee:** The application drafting engine is strictly prohibited from inventing false qualifications, credentials, or metrics.
- **GDPR Compliance:** Users have full data portability (CSV export) and right-to-be-forgotten data deletion.
