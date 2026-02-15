# Deployment (Vercel + FastAPI)

## Frontend (Vercel)

1. Create a new Vercel project and import the repo.
2. Set the environment variable:
   - `NEXT_PUBLIC_API_BASE_URL` = your public FastAPI HTTPS URL
3. Deploy. This repo uses Next.js App Router.

### Build command
- `npm run build`

### Output
- Standard Next.js output.

## Backend (FastAPI)

Ensure CORS allows:
- `https://momentumfirmfinance.com`
- `https://www.momentumfirmfinance.com`
- `http://localhost:3000`
- `http://127.0.0.1:3000`

If you use Vercel preview domains, add them explicitly or extend CORS logic safely.

## Custom Domain (Hostinger → Vercel)

Use the DNS values shown in the Vercel domain configuration screen.
Set both apex and `www` records exactly as Vercel provides.

## Troubleshooting

- **Mixed content error:** Ensure `NEXT_PUBLIC_API_BASE_URL` is `https://...`.
- **CORS error:** Confirm backend CORS origins include your Vercel domain and custom domain.
- **Wrong API base:** The UI shows a warning when a localhost URL is used in production.
