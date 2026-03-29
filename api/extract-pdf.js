export const config = { runtime: 'nodejs', maxDuration: 60 };

// Simple rate limiting via in-memory store (resets on cold start, good enough for MVP)
const requestLog = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  const windowMs = 60 * 1000; // 1 minute
  const maxRequests = 5;
  const key = ip || 'unknown';
  const requests = requestLog.get(key) || [];
  const recent = requests.filter(t => now - t < windowMs);
  if (recent.length >= maxRequests) return true;
  recent.push(now);
  requestLog.set(key, recent);
  return false;
}

function isValidSupabaseUrl(url) {
  // Only allow URLs from our own Supabase storage bucket
  try {
    const parsed = new URL(url);
    return parsed.hostname === 'bglhfmwjfnmybcrjlscm.supabase.co' &&
           parsed.pathname.includes('/storage/v1/object/') &&
           parsed.pathname.includes('rating-decisions');
  } catch {
    return false;
  }
}

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  // Rate limiting
  const ip = req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip');
  if (isRateLimited(ip)) {
    return new Response(JSON.stringify({ error: 'Too many requests — you can upload up to 5 PDFs per minute. Wait a moment and try again.' }), {
      status: 429,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // Auth check - require Supabase JWT
  const authHeader = req.headers.get('authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return new Response(JSON.stringify({ error: 'You need to be logged in to upload files. Please log in and try again.' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const { file_url, user_id } = await req.json();

    if (!file_url) {
      return new Response(JSON.stringify({ error: 'file_url is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // SSRF protection - only allow our own Supabase bucket
    if (!isValidSupabaseUrl(file_url)) {
      return new Response(JSON.stringify({ error: 'Invalid file URL' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Fetch the PDF
    const pdfResponse = await fetch(file_url);
    if (!pdfResponse.ok) {
      return new Response(JSON.stringify({ error: 'Could not retrieve your PDF from storage. The file may have been deleted or the link expired — try uploading again.' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // File size check - reject anything over 20MB
    const contentLength = pdfResponse.headers.get('content-length');
    if (contentLength && parseInt(contentLength) > 20 * 1024 * 1024) {
      return new Response(JSON.stringify({ error: 'File too large. Max 20MB.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Convert to base64 in chunks to avoid call stack overflow
    const pdfBuffer = await pdfResponse.arrayBuffer();
    const uint8Array = new Uint8Array(pdfBuffer);
    let binary = '';
    const chunkSize = 8192;
    for (let i = 0; i < uint8Array.length; i += chunkSize) {
      const chunk = uint8Array.subarray(i, i + chunkSize);
      binary += String.fromCharCode.apply(null, chunk);
    }
    const pdfBase64 = btoa(binary);

    // Call Claude API with comprehensive VA document extraction prompt
    const claudeResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 3000,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'document',
                source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 }
              },
              {
                type: 'text',
                text: `You are a VA benefits document expert. Extract every piece of useful claims information from this VA document, regardless of document type or format.

The document may be any of the following: rating decision letter, award/notification letter, denial letter, supplemental claim decision, C&P examination report, combined rating letter, HLR or BVA decision, or any other VA correspondence.

EXTRACT ALL OF THE FOLLOWING that appear anywhere in the document:

1. CONDITIONS — Every medical condition mentioned, including:
   - Conditions that were SERVICE CONNECTED with a rating %
   - Conditions that were DENIED service connection
   - Conditions that were DEFERRED
   - Conditions mentioned in C&P exams even without a rating
   - Secondary conditions referenced
   For each: name, diagnostic_code (if shown), rating percentage (or null), status, effective_date, and any relevant notes.

2. COMBINED RATING — The veteran's overall combined rating % if mentioned anywhere

3. EFFECTIVE DATES — Any effective dates for ratings or awards

4. MONTHLY PAYMENT — Any dollar amounts listed as monthly compensation

5. KEY DECISIONS — Any favorable findings, reasons for denial, appeal options mentioned

6. DOCUMENT TYPE — What type of VA document this is

Return ONLY valid JSON in this exact format — no markdown, no explanation:
{
  "document_type": "Rating Decision Letter",
  "combined_rating": 90,
  "monthly_payment": 2044.89,
  "effective_date": "2024-03-01",
  "conditions": [
    {
      "condition_name": "PTSD",
      "diagnostic_code": "9411",
      "rating": 70,
      "decision": "Service Connected",
      "effective_date": "2023-09-03",
      "notes": "any relevant notes"
    }
  ],
  "favorable_findings": ["string array"],
  "denial_reasons": ["string array"],
  "appeal_options": ["string array"],
  "summary": "2-3 sentence plain English summary of what this document means for the veteran"
}

Rules:
- decision must be exactly: "Service Connected", "Denied", "Deferred", or "Pending"
- rating must be an integer or null if no rating assigned
- effective_date format: YYYY-MM-DD or null
- diagnostic_code is a string or null
- Use null or empty array [] for fields not found
- Do NOT guess or fabricate — only extract what is explicitly stated
- Include ALL conditions even denied, deferred, or unrated ones
- Look across ALL pages — conditions may be scattered throughout`
              }
            ]
          }
        ]
      })
    });

    if (!claudeResponse.ok) {
      return new Response(JSON.stringify({ error: 'Our AI could not process this document right now. Please try again in a few seconds.' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const claudeData = await claudeResponse.json();
    const rawText = claudeData.content?.[0]?.text || '{}';

    let parsed;
    try {
      const cleaned = rawText.replace(/```json|```/g, '').trim();
      parsed = JSON.parse(cleaned);
    } catch {
      return new Response(JSON.stringify({ error: 'We had trouble reading this PDF — it may be a scanned image or an unusual format. Try a different copy of your rating decision.' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Log upload to uploads table
    if (user_id && user_id !== 'temp') {
      try {
        const filename = file_url.split('/').pop().split('?')[0];
        const decodedFilename = decodeURIComponent(filename).replace(/^\d+-/, '');
        await fetch(`https://bglhfmwjfnmybcrjlscm.supabase.co/rest/v1/uploads`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
            'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
            'Prefer': 'return=minimal'
          },
          body: JSON.stringify({
            user_id,
            original_filename: decodedFilename,
            file_url,
            conditions_found: (parsed.conditions || []).length
          })
        });
      } catch { /* non-fatal */ }
    }

    return new Response(JSON.stringify({
      success: true,
      user_id: user_id || null,
      document_type: parsed.document_type || null,
      combined_rating: parsed.combined_rating || null,
      monthly_payment: parsed.monthly_payment || null,
      effective_date: parsed.effective_date || null,
      conditions: (parsed.conditions || []).map(c => ({
        condition_name: c.condition_name || c.name || 'Unknown',
        diagnostic_code: c.diagnostic_code || null,
        rating: c.rating,
        decision: c.decision || 'Pending',
        effective_date: c.effective_date || null,
        notes: c.notes || null
      })),
      favorable_findings: parsed.favorable_findings || [],
      denial_reasons: parsed.denial_reasons || [],
      appeal_options: parsed.appeal_options || [],
      summary: parsed.summary || null,
      count: (parsed.conditions || []).length
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: 'Something unexpected happened on our end. Please try again — if this keeps happening, email support@underratedvets.com.' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
