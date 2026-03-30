export const config = { runtime: 'nodejs' };

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
  console.log('extract-pdf handler called');
  const contentLength = req.headers.get('content-length');
  console.log('Request content-length:', contentLength);

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

  let body;
  try {
    body = await req.json();
    console.log('Body parsed, has pdf_base64:', !!body.pdf_base64, 'length:', body.pdf_base64 ? body.pdf_base64.length : 0);
  } catch (e) {
    console.error('Body parse error:', e.message);
    return new Response(JSON.stringify({ error: 'Request body parse failed: ' + e.message }), {
      status: 400, headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const { file_url, user_id, pdf_base64 } = body;

    if (!file_url && !pdf_base64) {
      return new Response(JSON.stringify({ error: 'file_url or pdf_base64 is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Get PDF as base64 — prefer frontend-provided, fallback to fetch
    let pdfBase64;
    if (pdf_base64) {
      pdfBase64 = pdf_base64;
      console.log('Using base64 from frontend, length:', pdfBase64.length);
    } else {
      // Fallback: fetch from Supabase storage URL
      if (!isValidSupabaseUrl(file_url)) {
        return new Response(JSON.stringify({ error: 'Invalid file URL' }), {
          status: 400, headers: { 'Content-Type': 'application/json' }
        });
      }
      console.log('Fetching PDF from:', file_url);
      const fetchStart = Date.now();
      const pdfResponse = await fetch(file_url);
      console.log('PDF fetch status:', pdfResponse.status, 'took:', Date.now() - fetchStart, 'ms');
      if (!pdfResponse.ok) {
        return new Response(JSON.stringify({ error: 'Could not retrieve your PDF from storage.' }), {
          status: 500, headers: { 'Content-Type': 'application/json' }
        });
      }
      const contentLength = pdfResponse.headers.get('content-length');
      if (contentLength && parseInt(contentLength) > 20 * 1024 * 1024) {
        return new Response(JSON.stringify({ error: 'File too large. Max 20MB.' }), {
          status: 400, headers: { 'Content-Type': 'application/json' }
        });
      }
      const pdfBuffer = await pdfResponse.arrayBuffer();
      const uint8Array = new Uint8Array(pdfBuffer);
      let binary = '';
      const chunkSize = 8192;
      for (let i = 0; i < uint8Array.length; i += chunkSize) {
        const chunk = uint8Array.subarray(i, i + chunkSize);
        binary += String.fromCharCode.apply(null, chunk);
      }
      pdfBase64 = btoa(binary);
      console.log('PDF fetched and converted, length:', pdfBase64.length);
    }

    // Call Claude API with comprehensive VA document extraction prompt
    console.log('Calling Claude API...');
    const claudeStart = Date.now();
    const claudeResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
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
                text: `Extract VA benefits data from this document. Return ONLY valid JSON, no other text:
{
  "document_type": "string",
  "combined_rating": number or null,
  "monthly_payment": number or null,
  "conditions": [
    {
      "condition_name": "string",
      "diagnostic_code": "string or null",
      "rating": number or null,
      "decision": "Service Connected|Denied|Deferred|Pending",
      "notes": "string or null"
    }
  ],
  "favorable_findings": ["string"],
  "denial_reasons": ["string"],
  "summary": "1-2 sentence plain English summary"
}
Include ALL conditions mentioned. decision values must be exactly: Service Connected, Denied, Deferred, or Pending. rating is integer or null. Use null for missing fields.`
              }
            ]
          }
        ]
      })
    });

    console.log('Claude API response:', claudeResponse.status, 'took:', Date.now() - claudeStart, 'ms');
    if (!claudeResponse.ok) {
      const errBody = await claudeResponse.text();
      console.error('Claude API error:', claudeResponse.status, errBody);
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
