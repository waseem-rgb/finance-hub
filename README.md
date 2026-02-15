# Finance Hub (UAE Bank-Grade)
Monorepo:
- backend/  FastAPI + Ratio Engine + Workflow + Audit + AI session store
- frontend/ Next.js premium role-based dashboards (CFO/CEO/Director/Shareholder/CB)
- docs/     Architecture + ratio catalog + UAE compliance notes
- infra/    Docker compose + deployment notes

## Local Dev

### Backend
```sh
cd backend
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --reload-dir app --port 8000
```

### Frontend
```sh
cd frontend
npm install
npm run dev
```
