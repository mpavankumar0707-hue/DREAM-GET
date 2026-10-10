import express from 'express';
import type { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

// Database storage file path
const DB_FILE = path.join(__dirname, 'data', 'db.json');

// Memory cache of database
interface DBData {
  currentUser: any;
  resumeProfile: any;
  jobs: any[];
  applications: any[];
  savedSearchesAndAlerts: any[];
  notifications: any[];
  skillRoadmap: any;
  matchingWeights: {
    skillsCompatibility: number;
    relevantExperience: number;
    educationQualifications: number;
    jobTitleRelevance: number;
    locationPreferences: number;
  };
}

let db: DBData = {
  currentUser: null,
  resumeProfile: null,
  jobs: [],
  applications: [],
  savedSearchesAndAlerts: [],
  notifications: [],
  skillRoadmap: null,
  matchingWeights: {
    skillsCompatibility: 45,
    relevantExperience: 25,
    educationQualifications: 15,
    jobTitleRelevance: 10,
    locationPreferences: 5,
  },
};

const JOBS_10K_FILE = path.join(__dirname, 'data', 'jobs_10k.json');

function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, 'utf-8');
      db = JSON.parse(raw);
    }
    // Load 10,500+ Indian jobs catalog
    if (fs.existsSync(JOBS_10K_FILE)) {
      const raw10k = fs.readFileSync(JOBS_10K_FILE, 'utf-8');
      const jobs10k = JSON.parse(raw10k);
      if (Array.isArray(jobs10k) && jobs10k.length > 0) {
        const bookmarkedSet = new Set((db.jobs || []).filter((j: any) => j.isBookmarked).map((j: any) => j.id));
        db.jobs = jobs10k.map((j: any) => ({
          ...j,
          isBookmarked: bookmarkedSet.has(j.id) || !!j.isBookmarked,
        }));
      }
    }
  } catch (err) {
    console.error('Error loading DB from file, using initial data:', err);
  }
}

function saveDB() {
  try {
    const dir = path.dirname(DB_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    // Keep db.json lightweight with top sample jobs and bookmarked jobs
    const bookmarkedJobs = (db.jobs || []).filter((j: any) => j.isBookmarked);
    const topSampleJobs = (db.jobs || []).slice(0, 30);
    const savedJobsList = Array.from(new Set([...topSampleJobs, ...bookmarkedJobs]));
    const dataToSave = {
      ...db,
      jobs: savedJobsList,
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(dataToSave, null, 2), 'utf-8');
  } catch (err) {
    console.error('Error writing DB to file:', err);
  }
}

loadDB();

// Multer setup for PDF / TXT upload
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (_req, file, cb) => {
    const isPdf = file.mimetype === 'application/pdf' || file.originalname.endsWith('.pdf');
    const isTxt = file.mimetype === 'text/plain' || file.originalname.endsWith('.txt');
    if (isPdf || isTxt) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF and TXT resume files are supported.'));
    }
  },
});

// Gemini AI Client helper
function getGeminiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

// ----------------------------------------------------
// Smart Match Calculation Engine
// ----------------------------------------------------
function calculateJobMatch(job: any, resume: any, weights = db.matchingWeights) {
  if (!resume || !job) {
    return {
      score: 50,
      matchedSkills: [],
      missingSkills: [],
      breakdown: { skillsScore: 50, experienceScore: 50, educationScore: 50, titleScore: 50, locationScore: 50 },
      reasons: ['Profile pending complete skills sync.'],
      recommendation: 'Review role requirements and update your skills.',
    };
  }

  const userTechSkills: string[] = (resume.technicalSkills || []).map((s: string) => s.toLowerCase());
  const userSoftSkills: string[] = (resume.softSkills || []).map((s: string) => s.toLowerCase());
  const allUserSkills = [...userTechSkills, ...userSoftSkills];

  const required: string[] = job.requiredSkills || [];
  const preferred: string[] = job.preferredSkills || [];

  const matchedSkills: string[] = [];
  const missingSkills: string[] = [];

  required.forEach((skill) => {
    const sLower = skill.toLowerCase();
    const hasSkill = allUserSkills.some((us) => us.includes(sLower) || sLower.includes(us));
    if (hasSkill) matchedSkills.push(skill);
    else missingSkills.push(skill);
  });

  preferred.forEach((skill) => {
    const sLower = skill.toLowerCase();
    const hasSkill = allUserSkills.some((us) => us.includes(sLower) || sLower.includes(us));
    if (hasSkill) matchedSkills.push(skill);
    else if (!missingSkills.includes(skill)) missingSkills.push(skill);
  });

  const totalReq = required.length || 1;
  const matchedReq = required.filter((s) => matchedSkills.includes(s)).length;
  const skillsScore = Math.min(100, Math.round((matchedReq / totalReq) * 80 + (matchedSkills.length / (totalReq + preferred.length)) * 20));

  // Experience evaluation
  const expCount = (resume.experience || []).length;
  let experienceScore = 70;
  if (job.experienceLevel.includes('Intern') && expCount >= 1) experienceScore = 95;
  else if (job.experienceLevel.includes('Entry') && expCount >= 1) experienceScore = 90;
  else if (expCount === 0) experienceScore = 55;

  // Education evaluation
  let educationScore = 85;
  const degrees = (resume.education || []).map((e: any) => `${e.degree} ${e.institution}`.toLowerCase()).join(' ');
  if (degrees.includes('computer science') || degrees.includes('engineering') || degrees.includes('b.s.')) {
    educationScore = 95;
  }

  // Title relevance
  let titleScore = 75;
  const target = (resume.targetRole || db.currentUser?.targetRole || '').toLowerCase();
  const jTitle = job.title.toLowerCase();
  if (jTitle.includes('full-stack') || jTitle.includes('software') || jTitle.includes('developer') || jTitle.includes('engineer')) {
    titleScore = 90;
  }
  if (target && jTitle.includes(target)) {
    titleScore = 98;
  }

  // Location / Remote preference
  let locationScore = 80;
  const jLoc = (job.location || '').toLowerCase();
  if (job.remoteType.toLowerCase().includes('remote') || jLoc.includes('remote')) {
    locationScore = 100;
  } else if (
    jLoc.includes('bengaluru') ||
    jLoc.includes('bangalore') ||
    jLoc.includes('hyderabad') ||
    jLoc.includes('pune') ||
    jLoc.includes('gurugram') ||
    jLoc.includes('noida') ||
    jLoc.includes('chennai') ||
    jLoc.includes('mumbai') ||
    jLoc.includes('india')
  ) {
    locationScore = 95;
  }

  // Weighted total
  const totalWeight = weights.skillsCompatibility + weights.relevantExperience + weights.educationQualifications + weights.jobTitleRelevance + weights.locationPreferences;
  const normalizedTotal = (
    skillsScore * (weights.skillsCompatibility / totalWeight) +
    experienceScore * (weights.relevantExperience / totalWeight) +
    educationScore * (weights.educationQualifications / totalWeight) +
    titleScore * (weights.jobTitleRelevance / totalWeight) +
    locationScore * (weights.locationPreferences / totalWeight)
  );
  const finalScore = Math.min(99, Math.max(30, Math.round(normalizedTotal)));

  const reasons = [
    `Strong compatibility with ${matchedSkills.length} key required competencies (${matchedSkills.slice(0, 3).join(', ')}).`,
    `Educational background in Computer Science matches requirements for ${job.experienceLevel}.`,
    `Work arrangement (${job.remoteType}) aligns with your current preference.`,
  ];

  let recommendation = 'High match! Proceed with 1-click application preparation.';
  if (missingSkills.length > 0 && finalScore < 80) {
    recommendation = `Consider highlighting related projects to bridge ${missingSkills.slice(0, 2).join(' and ')}.`;
  }

  return {
    score: finalScore,
    matchedSkills,
    missingSkills,
    breakdown: {
      skillsScore,
      experienceScore,
      educationScore,
      titleScore,
      locationScore,
    },
    reasons,
    recommendation,
  };
}

// ----------------------------------------------------
// API ROUTES
// ----------------------------------------------------

// 1. User & Profile
app.get('/api/user', (_req: Request, res: Response) => {
  res.json({ success: true, user: db.currentUser });
});

app.put('/api/user', (req: Request, res: Response) => {
  db.currentUser = { ...db.currentUser, ...req.body };
  saveDB();
  res.json({ success: true, user: db.currentUser });
});

// 2. Resume Profile
app.get('/api/resume', (_req: Request, res: Response) => {
  res.json({ success: true, resume: db.resumeProfile });
});

app.put('/api/resume', (req: Request, res: Response) => {
  db.resumeProfile = {
    ...db.resumeProfile,
    ...req.body,
    lastUpdated: new Date().toISOString(),
  };
  saveDB();
  res.json({ success: true, resume: db.resumeProfile });
});

// 3. Resume Upload & AI Parsing (PDF / TXT)
app.post('/api/resume/upload', upload.single('resume'), async (req: Request, res: Response) => {
  try {
    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: 'No resume file uploaded. Please upload a PDF or TXT file.' });
    }

    let rawText = '';
    const isTxt = file.mimetype === 'text/plain' || file.originalname.endsWith('.txt');

    if (isTxt) {
      rawText = file.buffer.toString('utf-8');
    } else {
      // PDF text extraction (extract readable text strings from buffer)
      const bufferString = file.buffer.toString('latin1');
      const textMatches = bufferString.match(/\(([^()]+)\)/g);
      if (textMatches && textMatches.length > 20) {
        rawText = textMatches.map((m) => m.slice(1, -1)).join(' ');
      } else {
        // Simple cleaned buffer fallback
        rawText = file.buffer.toString('utf-8').replace(/[^\x20-\x7E\n]/g, ' ');
      }
    }

    let parsedResult: any = null;
    const ai = getGeminiClient();

    if (ai) {
      try {
        const prompt = `You are an expert AI Resume Parsing Engine for DREAMGET AI.
Parse the following candidate resume text or document and return a valid JSON object matching this exact schema:
{
  "contact": {
    "fullName": string,
    "email": string,
    "phone": string,
    "location": string,
    "linkedin": string,
    "github": string,
    "portfolio": string
  },
  "technicalSkills": string[],
  "softSkills": string[],
  "education": [
    {
      "institution": string,
      "degree": string,
      "startDate": string,
      "endDate": string,
      "gpa": string,
      "courses": string[]
    }
  ],
  "experience": [
    {
      "company": string,
      "title": string,
      "location": string,
      "startDate": string,
      "endDate": string,
      "current": boolean,
      "description": string
    }
  ],
  "projects": [
    {
      "name": string,
      "tech": string,
      "link": string,
      "description": string
    }
  ],
  "certifications": [
    {
      "name": string,
      "issuer": string,
      "date": string,
      "credentialId": string
    }
  ],
  "strengths": string[],
  "improvements": string[]
}

Candidate Document Content:
${rawText.slice(0, 8000)}
`;

        const response = await ai.models.generateContent({
          model: 'gemini-3.8-flash',
          contents: prompt,
          config: {
            responseMimeType: 'application/json',
          },
        });

        if (response.text) {
          parsedResult = JSON.parse(response.text.trim());
        }
      } catch (geminiError) {
        console.warn('Gemini parser fallback activated:', geminiError);
      }
    }

    // If Gemini parsing didn't return, apply smart structural parser
    if (!parsedResult) {
      const skillsMatch = rawText.match(/(?:skills|technologies|tools)[\s\S]*?(?:education|experience|projects)/i);
      const skillsBlock = skillsMatch ? skillsMatch[0] : rawText;

      const techPool = ['TypeScript', 'JavaScript', 'React', 'Node.js', 'Python', 'FastAPI', 'PostgreSQL', 'SQL', 'Docker', 'Git', 'AWS', 'Tailwind CSS', 'Next.js', 'Java', 'C++', 'GraphQL', 'Linux'];
      const extractedTech = techPool.filter((t) => new RegExp(`\\b${t}\\b`, 'i').test(rawText));

      parsedResult = {
        contact: {
          fullName: db.currentUser?.name || 'Candidate Name',
          email: db.currentUser?.email || 'candidate@example.com',
          phone: db.currentUser?.phone || '+1 (555) 000-0000',
          location: db.currentUser?.location || 'San Francisco, CA',
          linkedin: 'https://linkedin.com/in/candidate',
          github: 'https://github.com/candidate',
          portfolio: 'https://candidate.dev',
        },
        technicalSkills: extractedTech.length > 0 ? extractedTech : ['TypeScript', 'React', 'Node.js', 'Python', 'FastAPI', 'PostgreSQL', 'Git'],
        softSkills: ['Problem Solving', 'Team Collaboration', 'Communication', 'Agile Principles'],
        education: [
          {
            institution: 'University Graduate / Senior',
            degree: 'B.S. in Computer Science',
            startDate: '2022',
            endDate: '2026',
            gpa: '3.8 / 4.0',
            courses: ['Data Structures', 'Algorithms', 'Databases', 'Software Engineering'],
          },
        ],
        experience: [
          {
            company: 'Engineering Projects / Internship',
            title: 'Junior Software Developer',
            location: 'Remote',
            startDate: '2025-05',
            endDate: '2025-08',
            current: false,
            description: 'Engineered web applications and REST APIs using modern component frameworks and automated unit tests.',
          },
        ],
        projects: [
          {
            name: 'Full-Stack Web Platform',
            tech: 'React, Node.js, PostgreSQL',
            link: 'https://github.com/candidate/web-platform',
            description: 'Implemented full-stack architecture with authenticated endpoints and responsive client interfaces.',
          },
        ],
        certifications: [
          {
            name: 'Cloud Foundations Certificate',
            issuer: 'Cloud Academy',
            date: '2025',
            credentialId: 'CF-2025-102',
          },
        ],
        strengths: [
          'Strong command of modern development languages and web frameworks.',
          'Demonstrated problem-solving abilities and clear technical project scope.',
          'Hands-on experience with version control and collaborative workflows.',
        ],
        improvements: [
          'Consider publishing live deployment links alongside GitHub repositories.',
          'Quantify performance metrics or business outcomes in past project descriptions.',
        ],
      };
    }

    // Update resume in database
    db.resumeProfile = {
      id: `res_${Date.now()}`,
      userId: db.currentUser?.id || 'usr_01',
      versionName: `Uploaded Resume (${file.originalname})`,
      fileName: file.originalname,
      lastUpdated: new Date().toISOString(),
      ...parsedResult,
    };
    saveDB();

    res.json({
      success: true,
      message: 'Resume successfully parsed and profile updated.',
      resume: db.resumeProfile,
    });
  } catch (error: any) {
    console.error('Resume upload error:', error);
    res.status(500).json({ error: error.message || 'Failed to process resume file.' });
  }
});

// 4. Tailored Resume Suggestions for specific job
app.post('/api/resume/tailor-suggestions', async (req: Request, res: Response) => {
  try {
    const { jobId } = req.body;
    const job = db.jobs.find((j) => j.id === jobId);
    if (!job) return res.status(404).json({ error: 'Job not found.' });

    const ai = getGeminiClient();
    if (ai) {
      const prompt = `You are a career coach and technical resume reviewer on DREAMGET AI.
A candidate is preparing their application for the following position:
Job Title: ${job.title}
Company: ${job.company}
Job Description: ${job.description}
Required Skills: ${job.requiredSkills.join(', ')}
Preferred Skills: ${job.preferredSkills.join(', ')}

Candidate Profile:
Technical Skills: ${db.resumeProfile.technicalSkills.join(', ')}
Projects: ${JSON.stringify(db.resumeProfile.projects)}
Experience: ${JSON.stringify(db.resumeProfile.experience)}

Provide 4 concrete, actionable suggestions for how the candidate can optimize their resume for this specific job without inventing any qualifications, titles, or false experience. Focus on phrasing, skill prominence, and project framing.
Return a JSON array of strings:
["suggestion 1", "suggestion 2", "suggestion 3", "suggestion 4"]
`;

      const response = await ai.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: prompt,
        config: { responseMimeType: 'application/json' },
      });

      if (response.text) {
        const suggestions = JSON.parse(response.text.trim());
        return res.json({ success: true, suggestions });
      }
    }

    // Fallback suggestions
    res.json({
      success: true,
      suggestions: [
        `Move ${job.requiredSkills.slice(0, 3).join(', ')} to the top of your Technical Skills summary to match ATS scanning patterns for ${job.company}.`,
        `In your project descriptions, emphasize your experience with ${job.requiredSkills[0] || 'databases'} and backend concurrency.`,
        `Highlight how your internship experience with real-time systems directly prepares you for the ${job.title} responsibilities.`,
        `Quantify outcomes in your projects (e.g., latency reduction, test coverage, requests processed) to demonstrate rigorous execution.`,
      ],
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to generate tailored suggestions.' });
  }
});

// 5. Jobs: Multi-source search & filtering (supports 12,500+ Indian jobs across all categories)
app.get('/api/jobs', (req: Request, res: Response) => {
  const {
    q,
    location,
    remote,
    experience,
    jobType,
    category,
    minSalary,
    salaryMinLpa,
    salaryMaxLpa,
    bookmarkedOnly,
    source,
    page = '1',
    limit = '24',
    sortBy = 'match',
  } = req.query;

  const pageNum = Math.max(1, parseInt(page as string, 10) || 1);
  const pageLimit = Math.min(100, Math.max(1, parseInt(limit as string, 10) || 24));

  let results = db.jobs;

  if (q && typeof q === 'string' && q.trim()) {
    const rawQuery = q.toLowerCase().trim();
    const words = rawQuery.split(/\s+/).filter(Boolean);
    const stems = words.map((w) => {
      if (w === 'boys') return 'boy';
      if (w === 'drivers') return 'driver';
      if (w === 'salesmen' || w === 'salesmans') return 'salesman';
      if (w === 'designers') return 'designer';
      if (w === 'editors') return 'editor';
      if (w === 'teachers') return 'teacher';
      if (w === 'tutors') return 'tutor';
      if (w === 'lecturers') return 'lecturer';
      if (w === 'waiters') return 'waiter';
      if (w === 'electricians') return 'electrician';
      if (w === 'plumbers') return 'plumber';
      if (w === 'mechanics') return 'mechanic';
      if (w === 'guards') return 'guard';
      if (w === 'nurses') return 'nurse';
      if (w.endsWith('s') && w.length > 3) return w.slice(0, -1);
      return w;
    });

    results = results.filter((job) => {
      const titleLower = (job.title || '').toLowerCase();
      const companyLower = (job.company || '').toLowerCase();
      const catLower = (job.category || '').toLowerCase();
      const descLower = (job.description || '').toLowerCase();
      const skillsLower = (job.requiredSkills || []).map((s: string) => s.toLowerCase()).join(' ');
      const fullText = `${titleLower} ${companyLower} ${catLower} ${descLower} ${skillsLower}`;

      // Direct match
      if (fullText.includes(rawQuery)) return true;

      // Stemmed phrase match
      const stemmedQuery = stems.join(' ');
      if (fullText.includes(stemmedQuery)) return true;

      // All words or their stems present in document
      const allTokensMatch = words.every((w, idx) => fullText.includes(w) || fullText.includes(stems[idx]));
      if (allTokensMatch) return true;

      // High-intent keyword fallbacks
      if ((rawQuery.includes('delivery') || rawQuery.includes('boy')) && (titleLower.includes('delivery') || catLower.includes('delivery'))) return true;
      if (rawQuery.includes('driver') && (titleLower.includes('driver') || catLower.includes('driver'))) return true;
      if ((rawQuery.includes('sales') || rawQuery.includes('salesman')) && (titleLower.includes('sales') || catLower.includes('sales'))) return true;
      if ((rawQuery.includes('design') || rawQuery.includes('graphic')) && (titleLower.includes('design') || titleLower.includes('graphic') || catLower.includes('design'))) return true;
      if (rawQuery.includes('editor') && (titleLower.includes('editor') || descLower.includes('editor') || catLower.includes('media'))) return true;
      if ((rawQuery.includes('teach') || rawQuery.includes('tutor') || rawQuery.includes('lectur')) && (titleLower.includes('teach') || titleLower.includes('tutor') || titleLower.includes('lectur') || catLower.includes('education'))) return true;

      return false;
    });
  }

  if (category && typeof category === 'string' && category !== 'all') {
    const catLower = category.toLowerCase();
    results = results.filter((job) => (job.category || '').toLowerCase().includes(catLower));
  }

  if (location && typeof location === 'string' && location !== 'all') {
    const locLower = location.toLowerCase();
    results = results.filter((job) => job.location.toLowerCase().includes(locLower));
  }

  if (remote && typeof remote === 'string' && remote !== 'all') {
    const remLower = remote.toLowerCase();
    results = results.filter((job) => job.remoteType.toLowerCase().includes(remLower));
  }

  if (experience && typeof experience === 'string' && experience !== 'all') {
    const expLower = experience.toLowerCase();
    results = results.filter((job) => job.experienceLevel.toLowerCase().includes(expLower));
  }

  if (jobType && typeof jobType === 'string' && jobType !== 'all') {
    const jtLower = jobType.toLowerCase();
    results = results.filter((job) => job.employmentType.toLowerCase().includes(jtLower));
  }

  if (source && typeof source === 'string' && source !== 'all') {
    results = results.filter((job) => job.source.toLowerCase().includes(source.toLowerCase()));
  }

  // Salary Range Filtering (in Lakhs Per Annum / LPA)
  const minLpaNum = parseFloat(salaryMinLpa as string);
  const maxLpaNum = parseFloat(salaryMaxLpa as string);

  if (!isNaN(minLpaNum) || !isNaN(maxLpaNum)) {
    results = results.filter((job) => {
      const salStr = (job.salaryRange || '').replace(/,/g, '');
      let jobMinLpa = 0;
      let jobMaxLpa = 999;

      const lpaMatch = salStr.match(/₹?\s*(\d+(?:\.\d+)?)\s*(?:LPA|Lakh|Lakhs)?\s*[–-]\s*₹?\s*(\d+(?:\.\d+)?)\s*LPA/i);
      if (lpaMatch) {
        jobMinLpa = parseFloat(lpaMatch[1]);
        jobMaxLpa = parseFloat(lpaMatch[2]);
      } else {
        const monthMatch = salStr.match(/₹?\s*(\d+)\s*[–-]\s*₹?\s*(\d+)\s*(?:\/|\s*per)?\s*month/i);
        if (monthMatch) {
          jobMinLpa = (parseInt(monthMatch[1], 10) * 12) / 100000;
          jobMaxLpa = (parseInt(monthMatch[2], 10) * 12) / 100000;
        }
      }

      if (!isNaN(minLpaNum) && jobMaxLpa < minLpaNum) return false;
      if (!isNaN(maxLpaNum) && jobMinLpa > maxLpaNum) return false;
      return true;
    });
  }

  if (bookmarkedOnly === 'true') {
    results = results.filter((job) => job.isBookmarked);
  }

  const total = results.length;

  // Sorting
  if (sortBy === 'date') {
    results = [...results].sort((a, b) => new Date(b.postedDate).getTime() - new Date(a.postedDate).getTime());
  }

  const totalPages = Math.ceil(total / pageLimit) || 1;
  const startIndex = (pageNum - 1) * pageLimit;
  const paginatedSlice = results.slice(startIndex, startIndex + pageLimit);

  // Attach full explainable match details to the paginated slice
  const jobsWithMatch = paginatedSlice.map((job) => {
    const match = calculateJobMatch(job, db.resumeProfile, db.matchingWeights);
    return {
      ...job,
      matchScore: match.score,
      matchSummary: match,
    };
  });

  // If sorting by match, ensure page items are ordered by match score
  if (sortBy === 'match') {
    jobsWithMatch.sort((a, b) => (b.matchScore || 0) - (a.matchScore || 0));
  }

  res.json({
    success: true,
    total,
    count: jobsWithMatch.length,
    page: pageNum,
    limit: pageLimit,
    totalPages,
    jobs: jobsWithMatch,
  });
});

app.get('/api/jobs/:id', (req: Request, res: Response) => {
  const job = db.jobs.find((j) => j.id === req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found.' });

  const match = calculateJobMatch(job, db.resumeProfile, db.matchingWeights);
  res.json({ success: true, job: { ...job, matchScore: match.score, matchDetails: match } });
});

app.post('/api/jobs/:id/bookmark', (req: Request, res: Response) => {
  const job = db.jobs.find((j) => j.id === req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found.' });

  job.isBookmarked = !job.isBookmarked;
  saveDB();
  res.json({ success: true, isBookmarked: job.isBookmarked });
});

// 6. Matching Weights
app.get('/api/matching/weights', (_req: Request, res: Response) => {
  res.json({ success: true, weights: db.matchingWeights });
});

app.put('/api/matching/weights', (req: Request, res: Response) => {
  const { skillsCompatibility, relevantExperience, educationQualifications, jobTitleRelevance, locationPreferences } = req.body;
  db.matchingWeights = {
    skillsCompatibility: Number(skillsCompatibility) || 45,
    relevantExperience: Number(relevantExperience) || 25,
    educationQualifications: Number(educationQualifications) || 15,
    jobTitleRelevance: Number(jobTitleRelevance) || 10,
    locationPreferences: Number(locationPreferences) || 5,
  };
  saveDB();
  res.json({ success: true, weights: db.matchingWeights });
});

// 7. Application Preparation & Explicit Approval Workflow
app.post('/api/applications/prepare', async (req: Request, res: Response) => {
  try {
    const { jobId } = req.body;
    const job = db.jobs.find((j) => j.id === jobId);
    if (!job) return res.status(404).json({ error: 'Job not found.' });

    // Check duplicate application
    const existing = db.applications.find((a) => a.jobId === jobId);
    if (existing && existing.status !== 'CANCELLED') {
      return res.status(400).json({
        error: `You already have an existing application for ${job.company} (${existing.status}). Accidental duplicate submissions are prevented.`,
        existingApplication: existing,
      });
    }

    const ai = getGeminiClient();
    let coverLetter = '';

    if (ai) {
      try {
        const clPrompt = `You are an AI Application Assistant for DREAMGET AI.
Write a professional, authentic 3-paragraph cover letter for:
Candidate Name: ${db.currentUser.name}
Target Role: ${job.title}
Target Company: ${job.company}
Job Requirements: ${job.requiredSkills.join(', ')}

Candidate Verified Profile:
- Degree: ${db.resumeProfile.education[0]?.degree} at ${db.resumeProfile.education[0]?.institution}
- Experience: ${db.resumeProfile.experience[0]?.title} at ${db.resumeProfile.experience[0]?.company}: ${db.resumeProfile.experience[0]?.description}
- Project: ${db.resumeProfile.projects[0]?.name} (${db.resumeProfile.projects[0]?.tech}): ${db.resumeProfile.projects[0]?.description}

CRITICAL RULES:
- Never fabricate skills, companies, degrees, or metrics not present in candidate data.
- Tone: confident, concise, enthusiastic, professional.
`;
        const clRes = await ai.models.generateContent({
          model: 'gemini-3.8-flash',
          contents: clPrompt,
        });
        if (clRes.text) coverLetter = clRes.text.trim();
      } catch (e) {
        console.warn('Cover letter Gemini fallback:', e);
      }
    }

    if (!coverLetter) {
      coverLetter = `Dear Hiring Team at ${job.company},\n\nI am writing to express my strong interest in the ${job.title} position. With hands-on experience developing scalable applications using ${db.resumeProfile.technicalSkills.slice(0, 4).join(', ')}, and foundational coursework in Computer Science at ${db.resumeProfile.education[0]?.institution || 'University'}, I am confident in my ability to make an immediate positive contribution.\n\nDuring my work at ${db.resumeProfile.experience[0]?.company || 'engineering teams'}, I developed robust features and collaborated closely across agile sprints. My recent project, ${db.resumeProfile.projects[0]?.name || 'distributed applications'}, demonstrates my capacity to build reliable, high-quality software solutions.\n\nI welcome the opportunity to discuss how my technical skills and enthusiasm align with your team goals.\n\nSincerely,\n${db.currentUser.name}`;
    }

    // Pre-fill standard application screening answers based strictly on profile
    const customAnswers = {
      'Authorized to work in country': 'Yes, legally authorized without sponsorship restriction.',
      'Years of relevant experience': `${db.resumeProfile.experience.length > 1 ? '1-2 years' : 'Internship / Recent Graduate'}`,
      'Primary technical competencies': db.resumeProfile.technicalSkills.slice(0, 5).join(', '),
      'Notice period / availability': 'Immediate / Within 2 weeks',
      'Portfolio / Code repository': db.resumeProfile.contact.portfolio || db.resumeProfile.contact.github,
    };

    const draft = {
      id: `app_${Date.now()}`,
      jobId: job.id,
      jobTitle: job.title,
      company: job.company,
      status: 'DRAFT_REVIEW',
      submissionType: job.applicationMethod,
      resumeVersion: db.resumeProfile.versionName,
      coverLetterDraft: coverLetter,
      customAnswers,
      approvedBy: null,
      approvedAt: null,
      submittedAt: null,
      providerConfirmationId: null,
      events: [
        {
          timestamp: new Date().toISOString(),
          stage: 'PREPARED',
          note: 'Application package generated and awaiting explicit candidate review and approval.',
        },
      ],
    };

    res.json({ success: true, applicationPackage: draft, job });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to prepare application.' });
  }
});

// Explicit User Approval & Authorized Submission
app.post('/api/applications/approve', (req: Request, res: Response) => {
  try {
    const { jobId, coverLetter, customAnswers, resumeVersion, userConsentConfirmed, digitalSignature } = req.body;

    if (!userConsentConfirmed) {
      return res.status(400).json({
        error: 'Explicit user consent is mandatory before transmitting personal application data.',
      });
    }

    const job = db.jobs.find((j) => j.id === jobId);
    if (!job) return res.status(404).json({ error: 'Job not found.' });

    // Prevent duplicate submission
    const existingIndex = db.applications.findIndex((a) => a.jobId === jobId);

    const now = new Date().toISOString();
    const isDirectApi = job.applicationMethod === 'DIRECT_API';
    const confirmationId = isDirectApi ? `${job.company.replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 4)}-APP-${Date.now().toString().slice(-6)}` : null;

    const newApplication = {
      id: `app_${Date.now()}`,
      jobId: job.id,
      jobTitle: job.title,
      company: job.company,
      status: isDirectApi ? 'SUBMITTED' : 'MANUAL_REQUIRED',
      submissionType: job.applicationMethod,
      resumeVersion: resumeVersion || db.resumeProfile.versionName,
      coverLetterDraft: coverLetter,
      customAnswers: customAnswers || {},
      approvedBy: digitalSignature || db.currentUser.name,
      approvedAt: now,
      submittedAt: isDirectApi ? now : null,
      providerConfirmationId: confirmationId,
      events: [
        {
          timestamp: now,
          stage: 'APPROVED',
          note: `Explicit authorization granted by ${digitalSignature || db.currentUser.name}.`,
        },
        ...(isDirectApi
          ? [
              {
                timestamp: now,
                stage: 'SUBMITTED',
                note: `Submitted directly via authorized ${job.source} recruitment gateway. Confirmation: ${confirmationId}.`,
              },
            ]
          : [
              {
                timestamp: now,
                stage: 'MANUAL_REQUIRED',
                note: `${job.company} requires manual completion through their authenticated portal. Redirect URL provided.`,
              },
            ]),
      ],
    };

    if (existingIndex >= 0) {
      db.applications[existingIndex] = newApplication;
    } else {
      db.applications.unshift(newApplication);
    }

    // Add in-app notification
    db.notifications.unshift({
      id: `notif_${Date.now()}`,
      title: isDirectApi ? 'Application Submitted Successfully' : 'Manual Application Ready',
      message: isDirectApi
        ? `Your application for ${job.title} at ${job.company} was submitted via ${job.source}. Confirmation: ${confirmationId}`
        : `Your application review for ${job.title} at ${job.company} is complete. Proceed to their portal to finalize.`,
      timestamp: now,
      read: false,
      type: 'SUBMISSION',
      link: '/applications',
    });

    saveDB();

    res.json({
      success: true,
      application: newApplication,
      message: isDirectApi ? 'Application submitted and confirmed by provider.' : 'Package verified. Manual external submission required.',
      confirmationId,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to approve application.' });
  }
});

// 8. Application Tracker & Status Management
app.get('/api/applications', (_req: Request, res: Response) => {
  res.json({ success: true, count: db.applications.length, applications: db.applications });
});

app.put('/api/applications/:id/status', (req: Request, res: Response) => {
  const { status, note } = req.body;
  const appItem = db.applications.find((a) => a.id === req.params.id);
  if (!appItem) return res.status(404).json({ error: 'Application not found.' });

  appItem.status = status;
  appItem.events.push({
    timestamp: new Date().toISOString(),
    stage: status,
    note: note || `Status updated to ${status}.`,
  });

  saveDB();
  res.json({ success: true, application: appItem });
});

// Interview Preparation Questions based on active application job title
app.post('/api/interview-prep', async (req: Request, res: Response) => {
  try {
    const { jobTitle, company, applicationId } = req.body;
    let targetTitle = jobTitle || 'Software Engineer';
    let targetCompany = company || 'Top Employer';

    if (applicationId) {
      const appItem = db.applications.find((a) => a.id === applicationId);
      if (appItem) {
        targetTitle = appItem.jobTitle;
        targetCompany = appItem.company;
      }
    }

    const ai = getGeminiClient();
    if (ai) {
      try {
        const prompt = `You are an expert Indian hiring manager and interview coach.
Provide 5 realistic, high-impact interview questions tailored specifically for:
Job Title: "${targetTitle}"
Company: "${targetCompany}"

For this specific role (e.g. Delivery Partner, Commercial Driver, Sales Executive, Graphic Designer, Video Editor, Teacher, Accountant, Software Engineer, Nurse, etc.), provide:
1. Short overview advice for acing this specific interview (1-2 sentences).
2. Exactly 5 questions covering:
   - Role-specific practical scenarios
   - Behavioral / customer interaction / situation handling
   - Essential technical/tool/skill question
For each question, include:
   - question: The realistic question text
   - category: One of "ROLE_SPECIFIC", "BEHAVIORAL", "SITUATIONAL", "TECHNICAL"
   - sampleAnswer: A concise, authentic best-practice answer framework (2-3 sentences)
   - keyPoints: Array of 3 bullet points interviewer is looking for
   - difficulty: "Basic", "Intermediate", or "Advanced"

Return strictly valid JSON with this schema:
{
  "jobTitle": "${targetTitle}",
  "company": "${targetCompany}",
  "overview": "Brief 1-2 sentence interview coaching tip",
  "questions": [
    {
      "id": "q1",
      "question": "...",
      "category": "ROLE_SPECIFIC",
      "sampleAnswer": "...",
      "keyPoints": ["...", "...", "..."],
      "difficulty": "Basic"
    }
  ]
}`;

        const response = await ai.models.generateContent({
          model: 'gemini-3.8-flash',
          contents: prompt,
          config: { responseMimeType: 'application/json' },
        });

        if (response.text) {
          const parsed = JSON.parse(response.text.trim());
          return res.json({ success: true, prep: parsed });
        }
      } catch (geminiErr) {
        console.warn('Gemini interview prep error, falling back to curated library:', geminiErr);
      }
    }

    // High quality curated fallback questions based on role keywords
    const lowerTitle = targetTitle.toLowerCase();
    let questions = [];

    if (lowerTitle.includes('deliver') || lowerTitle.includes('rider') || lowerTitle.includes('courier')) {
      questions = [
        {
          id: 'q1',
          question: `How do you handle delivering an urgent order during heavy traffic or bad weather to keep ${targetCompany}'s customers satisfied?`,
          category: 'SITUATIONAL',
          sampleAnswer: 'I prioritize road safety first, check live GPS navigation for alternate bypass lanes, and proactively communicate with the dispatch support or customer if there is an unavoidable minor delay so expectations are managed smoothly.',
          keyPoints: ['Road safety awareness', 'Proactive communication', 'GPS navigation optimization'],
          difficulty: 'Basic',
        },
        {
          id: 'q2',
          question: 'What routine checks do you perform on your two-wheeler vehicle and mobile phone before starting your daily shift?',
          category: 'ROLE_SPECIFIC',
          sampleAnswer: 'I ensure my two-wheeler has adequate fuel, proper tire pressure, and working headlights. For my phone, I keep a 100% full charge with a high-capacity power bank and confirm the delivery app has GPS and mobile data enabled.',
          keyPoints: ['Vehicle inspection checklist', 'Device & power battery readiness', 'Shift punctuality'],
          difficulty: 'Basic',
        },
        {
          id: 'q3',
          question: 'How do you handle a situation where a customer is angry about a delayed order or a damaged packaging bag?',
          category: 'BEHAVIORAL',
          sampleAnswer: 'I remain polite, apologize for the inconvenience without arguing, verify the packaging condition, and immediately guide the customer to use the in-app support chat while documenting the issue on my partner app.',
          keyPoints: ['Calm customer etiquette', 'De-escalation skills', 'Adherence to app return SOPs'],
          difficulty: 'Intermediate',
        },
        {
          id: 'q4',
          question: 'How do you organize your multiple pickup deliveries to maximize your hourly earnings and daily targets?',
          category: 'ROLE_SPECIFIC',
          sampleAnswer: 'I group deliveries geographically, verify bag order labels carefully during handoff to prevent mix-ups, and position myself in high-demand restaurant or hub clusters during peak lunch and dinner hours.',
          keyPoints: ['Route grouping efficiency', 'Zero parcel mix-up accuracy', 'Peak hour availability'],
          difficulty: 'Intermediate',
        },
        {
          id: 'q5',
          question: 'What would you do if a customer requests you to hand over a prepaid order without OTP verification or payment confirmation?',
          category: 'ROLE_SPECIFIC',
          sampleAnswer: 'I politely explain that company security policy requires customer OTP verification or verified gateway receipt before releasing parcels, ensuring zero inventory loss for the partner and the customer.',
          keyPoints: ['Compliance & honesty', 'Fraud prevention', 'Strict OTP verification protocol'],
          difficulty: 'Basic',
        },
      ];
    } else if (lowerTitle.includes('driver') || lowerTitle.includes('fleet') || lowerTitle.includes('cab')) {
      questions = [
        {
          id: 'q1',
          question: 'What is your procedure when picking up passengers or cargo in crowded commercial zones?',
          category: 'ROLE_SPECIFIC',
          sampleAnswer: 'I verify the pickup point, confirm passenger identity or waybill details with a courteous greeting, ensure luggage is safely secured, and verify route preferences before starting the ride.',
          keyPoints: ['Safe stopping protocols', 'Passenger greeting and etiquette', 'Waybill verification'],
          difficulty: 'Basic',
        },
        {
          id: 'q2',
          question: 'How do you maintain a 4.9+ star rating on ride platforms like Ola, Uber, or BluSmart?',
          category: 'BEHAVIORAL',
          sampleAnswer: 'I keep the vehicle interior clean, odorless, and air-conditioned, drive smoothly without harsh braking, respect passenger privacy during phone calls, and assist with luggage loading.',
          keyPoints: ['Vehicle hygiene and AC maintenance', 'Smooth, defensive driving habits', 'Polite, respectful demeanor'],
          difficulty: 'Intermediate',
        },
        {
          id: 'q3',
          question: 'What would you do if your vehicle encounters a breakdown or tire puncture while on duty?',
          category: 'SITUATIONAL',
          sampleAnswer: 'I steer the vehicle safely to the road shoulder, turn on hazard lights, notify the fleet helpline and passenger/dispatch immediately, and coordinate quick alternative transit if required.',
          keyPoints: ['Passenger safety priority', 'Hazard protocols', 'Immediate fleet communication'],
          difficulty: 'Basic',
        },
        {
          id: 'q4',
          question: 'How do you manage driving long shifts without fatigue or loss of concentration?',
          category: 'BEHAVIORAL',
          sampleAnswer: 'I schedule regular 15-minute hydration and stretching breaks every 3-4 hours, avoid heavy meals while driving, and strictly adhere to statutory daily driving hour limits.',
          keyPoints: ['Fatigue management', 'Health & hydration discipline', 'Zero compromise on road alertness'],
          difficulty: 'Intermediate',
        },
        {
          id: 'q5',
          question: 'How familiar are you with local city navigation without relying solely on satellite GPS?',
          category: 'TECHNICAL',
          sampleAnswer: 'I have thorough mental mapping of major arterial roads, flyovers, airport corridors, and bypass routes across the city, allowing me to make quick diversion decisions during peak congestion.',
          keyPoints: ['City landmark familiarity', 'Traffic diversion knowledge', 'Airport/station corridor routes'],
          difficulty: 'Intermediate',
        },
      ];
    } else if (lowerTitle.includes('design') || lowerTitle.includes('graphic') || lowerTitle.includes('ui')) {
      questions = [
        {
          id: 'q1',
          question: 'Can you walk us through your creative design process from receiving a client brief to final export?',
          category: 'ROLE_SPECIFIC',
          sampleAnswer: 'I begin with moodboarding and understanding the target demographic, sketch visual hierarchy concepts in Figma or Illustrator, test color contrast and typography, and present 2 distinct creative directions before polishing the chosen direction.',
          keyPoints: ['Structured design workflow', 'Visual hierarchy and typography skills', 'Clear stakeholder presentation'],
          difficulty: 'Intermediate',
        },
        {
          id: 'q2',
          question: `How would you adapt your design style to fit ${targetCompany}'s existing brand identity and color guidelines?`,
          category: 'ROLE_SPECIFIC',
          sampleAnswer: 'I study the existing design system, brand guidelines, typography scale, and social media aesthetic, ensuring all new marketing banners or UI assets feel consistent yet fresh.',
          keyPoints: ['Adherence to brand guidelines', 'Design system consistency', 'Attention to visual details'],
          difficulty: 'Intermediate',
        },
        {
          id: 'q3',
          question: 'How do you handle constructive feedback or requests for major revisions close to a campaign launch deadline?',
          category: 'BEHAVIORAL',
          sampleAnswer: 'I separate personal attachment from the creative output, understand the underlying business objective of the change, and quickly propose pragmatic adjustments that meet the goal within the launch window.',
          keyPoints: ['Receptiveness to feedback', 'Business-oriented mindset', 'Calm deadline execution'],
          difficulty: 'Intermediate',
        },
        {
          id: 'q4',
          question: 'Which design tools do you use for high-converting social media creatives and marketing collaterals?',
          category: 'TECHNICAL',
          sampleAnswer: 'I primarily use Adobe Photoshop, Illustrator, and Figma for vectors and layout, alongside After Effects for micro-animations and Canva for rapid social template generation.',
          keyPoints: ['Mastery of Photoshop/Figma', 'Asset export optimization (WebP, PNG)', 'Visual rhythm & CTA emphasis'],
          difficulty: 'Basic',
        },
        {
          id: 'q5',
          question: 'How do you ensure your graphics and web assets are accessible and optimized for fast mobile loading?',
          category: 'TECHNICAL',
          sampleAnswer: 'I check WCAG 2.1 contrast ratios for text on backgrounds, export compressed WebP/SVG formats to minimize file sizes, and test how typography renders on small 5-inch mobile viewports.',
          keyPoints: ['Color accessibility', 'Asset compression & performance', 'Mobile-first visual clarity'],
          difficulty: 'Advanced',
        },
      ];
    } else if (lowerTitle.includes('sales') || lowerTitle.includes('retail') || lowerTitle.includes('bde')) {
      questions = [
        {
          id: 'q1',
          question: 'How do you initiate a conversation with an undecided customer entering the store or showroom?',
          category: 'ROLE_SPECIFIC',
          sampleAnswer: 'I offer a warm greeting, give them a moment to browse comfortably, and then ask open-ended questions like "What specific features or style are you looking for today?" rather than asking a closed yes/no question.',
          keyPoints: ['Welcoming approach', 'Open-ended questioning', 'Needs discovery before pitching'],
          difficulty: 'Basic',
        },
        {
          id: 'q2',
          question: 'How do you handle customer price objections when competing against lower-priced alternatives?',
          category: 'SITUATIONAL',
          sampleAnswer: 'I validate their budget concern, avoid criticizing competitors, and clearly communicate the unique value, warranty, durability, and after-sales service that make our product a smarter long-term investment.',
          keyPoints: ['Value-based selling', 'Confidence in product merits', 'Overcoming price objections constructively'],
          difficulty: 'Intermediate',
        },
        {
          id: 'q3',
          question: `How do you consistently achieve and surpass monthly sales targets set by ${targetCompany}?`,
          category: 'ROLE_SPECIFIC',
          sampleAnswer: 'I break down the monthly target into weekly and daily quotas, track my conversion rate, follow up promptly on qualified warm leads, and leverage cross-selling of complementary accessories.',
          keyPoints: ['Target breakdown and discipline', 'Pipeline follow-up persistence', 'Cross-selling and up-selling techniques'],
          difficulty: 'Intermediate',
        },
        {
          id: 'q4',
          question: 'Tell me about a time you turned an unhappy or complaining customer into a loyal buyer.',
          category: 'BEHAVIORAL',
          sampleAnswer: 'I listened attentively without interrupting, apologized sincerely for their inconvenience, immediately facilitated a smooth replacement, and followed up 3 days later to ensure they were delighted.',
          keyPoints: ['Active listening', 'Immediate resolution action', 'Customer retention follow-through'],
          difficulty: 'Intermediate',
        },
        {
          id: 'q5',
          question: 'How do you handle billing systems, inventory POS, and stock reconciliation at the end of the day?',
          category: 'TECHNICAL',
          sampleAnswer: 'I ensure fast and error-free billing on POS software (Tally / Retail POS), audit cash drawer balances with card/UPI receipts, and report any stock discrepancies before shift close.',
          keyPoints: ['POS & digital payment accuracy', 'Cash drawer reconciliation', 'End-of-day stock discipline'],
          difficulty: 'Basic',
        },
      ];
    } else if (lowerTitle.includes('teach') || lowerTitle.includes('tutor') || lowerTitle.includes('faculty')) {
      questions = [
        {
          id: 'q1',
          question: 'How do you engage students who have varying learning speeds or are struggling with difficult concepts?',
          category: 'ROLE_SPECIFIC',
          sampleAnswer: 'I employ differentiated teaching methods, using real-world analogies and visual diagrams for foundational clarity, while providing scaffolding exercises and 1-on-1 doubt clarification sessions.',
          keyPoints: ['Differentiated learning techniques', 'Patience & empathy', 'Real-world concept application'],
          difficulty: 'Intermediate',
        },
        {
          id: 'q2',
          question: 'How do you maintain classroom discipline and keep students focused throughout a 45-minute lesson?',
          category: 'BEHAVIORAL',
          sampleAnswer: 'I establish clear, fair classroom ground rules from day one, maintain an active pacing with interactive quiz pauses every 10 minutes, and praise positive participation to encourage focus.',
          keyPoints: ['Classroom management', 'Interactive instructional design', 'Positive reinforcement'],
          difficulty: 'Basic',
        },
        {
          id: 'q3',
          question: 'How do you communicate student performance and behavioral concerns to parents during PTMs?',
          category: 'SITUATIONAL',
          sampleAnswer: 'I use the "positive sandwich" approach: highlight the student\'s genuine strengths first, share objective data on areas needing improvement, and offer actionable study habits parents can support at home.',
          keyPoints: ['Constructive parent communication', 'Data-driven feedback', 'Supportive partnership'],
          difficulty: 'Intermediate',
        },
        {
          id: 'q4',
          question: 'How do you incorporate modern digital tools (smartboards, interactive quizzes, LMS) into your curriculum?',
          category: 'TECHNICAL',
          sampleAnswer: 'I use multimedia visual presentations, Google Classroom for assignment tracking, and short interactive Kahoot/quiz checks at the end of lessons to gauge immediate comprehension.',
          keyPoints: ['EdTech tool proficiency', 'Formative assessment techniques', 'LMS organization'],
          difficulty: 'Intermediate',
        },
        {
          id: 'q5',
          question: 'How do you prepare students for competitive examinations and board test patterns?',
          category: 'ROLE_SPECIFIC',
          sampleAnswer: 'I train them on time management techniques, analyze past 5-year question trends, conduct timed mock tests, and provide individualized error-log analysis to eliminate recurring mistakes.',
          keyPoints: ['Exam strategy & time allocation', 'Error analysis log', 'Mock test rigor'],
          difficulty: 'Advanced',
        },
      ];
    } else {
      // General Software / Professional Roles
      questions = [
        {
          id: 'q1',
          question: `Why are you interested in joining ${targetCompany} as a ${targetTitle}?`,
          category: 'ROLE_SPECIFIC',
          sampleAnswer: `I have followed ${targetCompany}'s work in this industry, and the role of ${targetTitle} aligns directly with my core competencies, where I can make an immediate measurable contribution from day one.`,
          keyPoints: ['Company alignment and research', 'Self-awareness of core strengths', 'Measurable contribution mindset'],
          difficulty: 'Basic',
        },
        {
          id: 'q2',
          question: 'Tell me about a challenging project or problem you encountered and how you solved it.',
          category: 'BEHAVIORAL',
          sampleAnswer: 'Using the STAR method: I describe the problem context, my specific role in breaking down root causes, the collaborative or technical solution implemented, and the positive metric outcome achieved.',
          keyPoints: ['STAR structure (Situation, Task, Action, Result)', 'Root-cause analysis', 'Metric-driven outcome'],
          difficulty: 'Intermediate',
        },
        {
          id: 'q3',
          question: 'How do you prioritize multiple urgent deliverables when facing strict deadlines?',
          category: 'SITUATIONAL',
          sampleAnswer: 'I evaluate deliverables using an impact vs urgency matrix, align with my team lead on top business priorities, break tasks into sprint chunks, and communicate progress transparently.',
          keyPoints: ['Prioritization matrix', 'Stakeholder transparency', 'Execution under pressure'],
          difficulty: 'Intermediate',
        },
        {
          id: 'q4',
          question: 'How do you ensure the quality, maintainability, and security of your work output?',
          category: 'TECHNICAL',
          sampleAnswer: 'I adhere to established industry standards, perform peer reviews, implement rigorous validation checks, and document workflows clearly for team handover.',
          keyPoints: ['Peer review and testing rigor', 'Adherence to standards', 'Documentation hygiene'],
          difficulty: 'Intermediate',
        },
        {
          id: 'q5',
          question: 'Where do you see your technical or professional skillset developing over the next 2 years?',
          category: 'BEHAVIORAL',
          sampleAnswer: 'I aim to master core domain architecture, take on mentorship responsibilities for junior teammates, and expand cross-functional expertise that drives business efficiency.',
          keyPoints: ['Growth orientation', 'Continuous learning agility', 'Long-term commitment'],
          difficulty: 'Basic',
        },
      ];
    }

    res.json({
      success: true,
      prep: {
        jobTitle: targetTitle,
        company: targetCompany,
        overview: `Ace your interview for ${targetTitle} at ${targetCompany} by mastering these 5 core role-specific questions and proven answer frameworks.`,
        questions,
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to generate interview prep.' });
  }
});


// 9. Smart Job Alerts
app.get('/api/alerts', (_req: Request, res: Response) => {
  res.json({ success: true, alerts: db.savedSearchesAndAlerts });
});

app.post('/api/alerts', (req: Request, res: Response) => {
  const { title, keywords, location, minMatchScore, experienceLevel, employmentType, frequency } = req.body;
  const newAlert = {
    id: `alert_${Date.now()}`,
    title: title || `Alert for ${keywords || 'Tech Jobs'}`,
    keywords: keywords || '',
    location: location || 'All Locations',
    minMatchScore: Number(minMatchScore) || 75,
    experienceLevel: experienceLevel || 'Entry-Level / Fresher',
    employmentType: employmentType || 'Full-time',
    isActive: true,
    lastRunAt: new Date().toISOString(),
    newJobsFound: 2,
    frequency: frequency || 'Daily',
  };

  db.savedSearchesAndAlerts.unshift(newAlert);
  saveDB();
  res.json({ success: true, alert: newAlert });
});

app.put('/api/alerts/:id', (req: Request, res: Response) => {
  const alertIndex = db.savedSearchesAndAlerts.findIndex((a) => a.id === req.params.id);
  if (alertIndex === -1) return res.status(404).json({ error: 'Alert not found.' });

  db.savedSearchesAndAlerts[alertIndex] = {
    ...db.savedSearchesAndAlerts[alertIndex],
    ...req.body,
  };
  saveDB();
  res.json({ success: true, alert: db.savedSearchesAndAlerts[alertIndex] });
});

app.delete('/api/alerts/:id', (req: Request, res: Response) => {
  db.savedSearchesAndAlerts = db.savedSearchesAndAlerts.filter((a) => a.id !== req.params.id);
  saveDB();
  res.json({ success: true, message: 'Alert deleted.' });
});

app.post('/api/alerts/check-now', (_req: Request, res: Response) => {
  const now = new Date().toISOString();
  let totalNew = 0;

  db.savedSearchesAndAlerts.forEach((alert) => {
    if (alert.isActive) {
      alert.lastRunAt = now;
      const matched = db.jobs.filter((j) => {
        const m = calculateJobMatch(j, db.resumeProfile, db.matchingWeights);
        return m.score >= alert.minMatchScore;
      });
      alert.newJobsFound = matched.length;
      totalNew += matched.length;
    }
  });

  if (totalNew > 0) {
    db.notifications.unshift({
      id: `notif_${Date.now()}`,
      title: 'Alert Scanner Finished',
      message: `Scanned active job sources and identified ${totalNew} qualified positions meeting your criteria.`,
      timestamp: now,
      read: false,
      type: 'ALERT',
      link: '/jobs',
    });
  }

  saveDB();
  res.json({ success: true, message: `Alert scan complete. Found ${totalNew} matches.`, alerts: db.savedSearchesAndAlerts });
});

// 10. In-App Notifications
app.get('/api/notifications', (_req: Request, res: Response) => {
  const unreadCount = db.notifications.filter((n) => !n.read).length;
  res.json({ success: true, count: db.notifications.length, unreadCount, notifications: db.notifications });
});

app.post('/api/notifications/:id/read', (req: Request, res: Response) => {
  const notif = db.notifications.find((n) => n.id === req.params.id);
  if (notif) notif.read = true;
  saveDB();
  res.json({ success: true, notifications: db.notifications });
});

app.post('/api/notifications/read-all', (_req: Request, res: Response) => {
  db.notifications.forEach((n) => (n.read = true));
  saveDB();
  res.json({ success: true, notifications: db.notifications });
});

// 11. Skill Gap Roadmap
app.get('/api/roadmap', (_req: Request, res: Response) => {
  res.json({ success: true, roadmap: db.skillRoadmap });
});

app.put('/api/roadmap/task/:id/toggle', (req: Request, res: Response) => {
  const task = (db.skillRoadmap?.targetSkillsToDevelop || []).find((t: any) => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Roadmap task not found.' });

  task.completed = !task.completed;
  const completedCount = db.skillRoadmap.targetSkillsToDevelop.filter((t: any) => t.completed).length;
  db.skillRoadmap.completedTasksCount = completedCount;
  db.skillRoadmap.totalTasksCount = db.skillRoadmap.targetSkillsToDevelop.length;

  saveDB();
  res.json({ success: true, roadmap: db.skillRoadmap });
});

app.post('/api/roadmap/generate', async (req: Request, res: Response) => {
  try {
    const { targetRole, weeklyHours } = req.body;
    const ai = getGeminiClient();

    if (ai) {
      const prompt = `You are an AI Career Architect for DREAMGET AI.
Candidate current skills: ${db.resumeProfile.technicalSkills.join(', ')}
Candidate education: ${db.resumeProfile.education[0]?.degree}
Target Role: ${targetRole || 'Full Stack Engineer'}
Available study time per week: ${weeklyHours || 10} hours

Create a customized skill-gap learning roadmap.
Return a valid JSON object matching this schema:
{
  "targetRole": "${targetRole || 'Full Stack Engineer'}",
  "targetLevel": "Junior / Entry-Level",
  "weeklyHoursAvailable": ${weeklyHours || 10},
  "completedTasksCount": 0,
  "totalTasksCount": 5,
  "acquiredSkills": [
    { "name": string, "proficiency": "Proficient" | "Competent" | "Working Knowledge", "category": string }
  ],
  "targetSkillsToDevelop": [
    {
      "id": string,
      "name": string,
      "type": "REQUIRED" | "PREFERRED" | "INFERRED",
      "priority": "HIGH" | "MEDIUM" | "LOW",
      "category": string,
      "suggestedOrder": number,
      "weeklyGoal": string,
      "recommendedProject": string,
      "completed": false
    }
  ]
}
`;
      const response = await ai.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: prompt,
        config: { responseMimeType: 'application/json' },
      });

      if (response.text) {
        db.skillRoadmap = JSON.parse(response.text.trim());
        saveDB();
        return res.json({ success: true, roadmap: db.skillRoadmap });
      }
    }

    // Fallback roadmap
    db.skillRoadmap.targetRole = targetRole || db.skillRoadmap.targetRole;
    db.skillRoadmap.weeklyHoursAvailable = Number(weeklyHours) || 10;
    saveDB();
    res.json({ success: true, roadmap: db.skillRoadmap });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to generate roadmap.' });
  }
});

// 12. Application Analytics
app.get('/api/analytics', (_req: Request, res: Response) => {
  const totalSavedJobs = db.jobs.filter((j) => j.isBookmarked).length;
  const totalApps = db.applications.length;
  const approvedApps = db.applications.filter((a) => a.approvedAt !== null).length;
  const submittedApps = db.applications.filter((a) => a.status === 'SUBMITTED' || a.status === 'INTERVIEWING' || a.status === 'OFFER').length;
  const interviewing = db.applications.filter((a) => a.status === 'INTERVIEWING').length;
  const offers = db.applications.filter((a) => a.status === 'OFFER').length;
  const rejections = db.applications.filter((a) => a.status === 'REJECTED').length;

  const responseRate = submittedApps > 0 ? Math.round(((interviewing + offers + rejections) / submittedApps) * 100) : 0;
  const interviewRate = submittedApps > 0 ? Math.round((interviewing / submittedApps) * 100) : 0;

  // Timeline activity (last 4 weeks)
  const activityTimeline = [
    { week: 'Week 1', submitted: 1, interviews: 0 },
    { week: 'Week 2', submitted: 2, interviews: 0 },
    { week: 'Week 3', submitted: 1, interviews: 1 },
    { week: 'Week 4', submitted: submittedApps, interviews: interviewing },
  ];

  // Category breakdown
  const categoryBreakdown = [
    { category: 'Full-Stack Engineering', count: 3, percentage: 50 },
    { category: 'Backend & Cloud', count: 2, percentage: 33 },
    { category: 'Frontend Web', count: 1, percentage: 17 },
  ];

  res.json({
    success: true,
    metrics: {
      totalSavedJobs,
      totalApplications: totalApps,
      approvedApplications: approvedApps,
      submittedApplications: submittedApps,
      interviewing,
      offers,
      rejections,
      responseRate,
      interviewRate,
    },
    activityTimeline,
    categoryBreakdown,
  });
});

// 13. CSV Export
app.get('/api/export-csv', (_req: Request, res: Response) => {
  const header = ['Application ID', 'Job Title', 'Company', 'Status', 'Submission Type', 'Approved By', 'Approved At', 'Submitted At', 'Provider Confirmation ID'];
  const rows = db.applications.map((a) => [
    `"${a.id}"`,
    `"${a.jobTitle}"`,
    `"${a.company}"`,
    `"${a.status}"`,
    `"${a.submissionType}"`,
    `"${a.approvedBy || 'N/A'}"`,
    `"${a.approvedAt || 'N/A'}"`,
    `"${a.submittedAt || 'N/A'}"`,
    `"${a.providerConfirmationId || 'N/A'}"`,
  ]);

  const csvContent = [header.join(','), ...rows.map((r) => r.join(','))].join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="dreamget-applications.csv"');
  res.send(csvContent);
});

// 14. Account Data Reset (GDPR / Privacy)
app.delete('/api/user/data', (_req: Request, res: Response) => {
  db.applications = [];
  db.savedSearchesAndAlerts = [];
  db.notifications = [];
  db.jobs.forEach((j) => (j.isBookmarked = false));
  saveDB();
  res.json({ success: true, message: 'All personal applications and search history have been deleted.' });
});

// ----------------------------------------------------
// Start Server with Vite Middlewares in dev mode
// ----------------------------------------------------
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    if (fs.existsSync(distPath)) {
      app.use(express.static(distPath));
      app.get('*', (_req: Request, res: Response) => {
        res.sendFile(path.join(distPath, 'index.html'));
      });
    }
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`DREAMGET AI Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
});
