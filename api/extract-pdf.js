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

    // Call Claude API
    const claudeResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-opus-4-6',
        max_tokens: 2048,
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
                text: `You are extracting VA disability claim data from this rating decision document.

Return ONLY a valid JSON object with no other text, no markdown, no explanation.

Format:
{
  "combined_rating": 90,
  "conditions": [
    {
      "condition_name": "PTSD",
      "diagnostic_code": "9411",
      "rating": 70,
      "decision": "service connected",
      "effective_date": "2023-09-03"
    }
  ]
}

Rules for combined_rating:
- Extract the official combined disability rating percentage EXACTLY as stated in the document
- Do NOT calculate or estimate it — use only what is printed
- Use null if no combined rating is stated

Rules for conditions:
- Extract every condition listed — service connected, not service connected, and deferred
- rating must be a number (integer) or null if no rating assigned
- decision must be exactly: "service connected", "not service connected", or "deferred"
- effective_date format: YYYY-MM-DD, or null if not found
- diagnostic_code is a string or null
- Include ALL conditions, even denied ones`
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
      combined_rating: parsed.combined_rating || null,
      conditions: parsed.conditions || [],
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
