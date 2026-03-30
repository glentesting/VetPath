export const config = { runtime: 'edge' };

const requestLog = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  const windowMs = 60 * 1000;
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
  try {
    const parsed = new URL(url);
    return parsed.hostname === 'bglhfmwjfnmybcrjlscm.supabase.co' &&
           parsed.pathname.includes('/storage/') &&
           parsed.pathname.includes('rating-decisions');
  } catch {
    return false;
  }
}

export default async function handler(req) {
  console.log('extract-pdf handler called');

  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const ip = req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip');
  if (isRateLimited(ip)) {
    return new Response(JSON.stringify({ error: 'Too many requests. Wait a moment and try again.' }), {
      status: 429, headers: { 'Content-Type': 'application/json' }
    });
  }

  const authHeader = req.headers.get('authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return new Response(JSON.stringify({ error: 'You need to be logged in.' }), {
      status: 401, headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const { file_url, user_id } = await req.json();
    console.log('file_url:', file_url ? file_url.substring(0, 80) + '...' : 'MISSING');

    if (!file_url) {
      return new Response(JSON.stringify({ error: 'file_url is required' }), {
        status: 400, headers: { 'Content-Type': 'application/json' }
      });
    }

    if (!isValidSupabaseUrl(file_url)) {
      console.error('Invalid URL rejected:', file_url);
      return new Response(JSON.stringify({ error: 'Invalid file URL' }), {
        status: 400, headers: { 'Content-Type': 'application/json' }
      });
    }

    // Fetch PDF from signed URL (pre-authenticated, no extra headers needed)
    console.log('Fetching PDF...');
    const fetchStart = Date.now();
    const pdfResponse = await fetch(file_url);
    console.log('PDF fetch:', pdfResponse.status, 'took:', Date.now() - fetchStart, 'ms');

    if (!pdfResponse.ok) {
      console.error('PDF fetch failed:', pdfResponse.status);
      return new Response(JSON.stringify({ error: 'Could not retrieve your PDF. Try uploading again.' }), {
        status: 500, headers: { 'Content-Type': 'application/json' }
      });
    }

    const pdfBuffer = await pdfResponse.arrayBuffer();
    const pdfSize = pdfBuffer.byteLength;
    console.log('PDF size:', Math.round(pdfSize / 1024), 'KB');

    if (pdfSize > 20 * 1024 * 1024) {
      return new Response(JSON.stringify({ error: 'File too large. Max 20MB.' }), {
        status: 400, headers: { 'Content-Type': 'application/json' }
      });
    }

    // Convert to base64
    const uint8Array = new Uint8Array(pdfBuffer);
    let binary = '';
    const chunkSize = 8192;
    for (let i = 0; i < uint8Array.length; i += chunkSize) {
      const chunk = uint8Array.subarray(i, i + chunkSize);
      binary += String.fromCharCode.apply(null, chunk);
    }
    const pdfBase64 = btoa(binary);
    console.log('Base64 ready, length:', pdfBase64.length);

    // Call Claude
    console.log('Calling Claude...');
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
        messages: [{
          role: 'user',
          content: [
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
            { type: 'text', text: `Extract VA benefits data from this document. Return ONLY valid JSON, no other text:
{
  "document_type": "string",
  "combined_rating": number or null,
  "monthly_payment": number or null,
  "conditions": [{"condition_name":"string","diagnostic_code":"string or null","rating":number or null,"decision":"Service Connected|Denied|Deferred|Pending","notes":"string or null"}],
  "favorable_findings": ["string"],
  "denial_reasons": ["string"],
  "summary": "1-2 sentence plain English summary"
}
Include ALL conditions. decision must be exactly: Service Connected, Denied, Deferred, or Pending. rating is integer or null. Use null for missing fields.` }
          ]
        }]
      })
    });

    console.log('Claude response:', claudeResponse.status, 'took:', Date.now() - claudeStart, 'ms');

    if (!claudeResponse.ok) {
      const errBody = await claudeResponse.text();
      console.error('Claude error:', claudeResponse.status, errBody.substring(0, 200));
      return new Response(JSON.stringify({ error: 'AI could not process this document. Try again.' }), {
        status: 500, headers: { 'Content-Type': 'application/json' }
      });
    }

    const claudeData = await claudeResponse.json();
    const rawText = claudeData.content?.[0]?.text || '{}';

    let parsed;
    try {
      parsed = JSON.parse(rawText.replace(/```json|```/g, '').trim());
    } catch {
      console.error('JSON parse failed, raw:', rawText.substring(0, 200));
      return new Response(JSON.stringify({ error: 'Could not read this PDF. Try a different copy.' }), {
        status: 500, headers: { 'Content-Type': 'application/json' }
      });
    }

    // Log upload to uploads table
    if (user_id && user_id !== 'temp' && file_url) {
      try {
        const filename = file_url.split('/').pop().split('?')[0];
        const decodedFilename = decodeURIComponent(filename).replace(/^\d+-/, '');
        await fetch('https://bglhfmwjfnmybcrjlscm.supabase.co/rest/v1/uploads', {
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

    console.log('Extraction complete:', (parsed.conditions || []).length, 'conditions found');

    return new Response(JSON.stringify({
      success: true,
      user_id: user_id || null,
      document_type: parsed.document_type || null,
      combined_rating: parsed.combined_rating || null,
      monthly_payment: parsed.monthly_payment || null,
      conditions: (parsed.conditions || []).map(c => ({
        condition_name: c.condition_name || c.name || 'Unknown',
        diagnostic_code: c.diagnostic_code || null,
        rating: c.rating,
        decision: c.decision || 'Pending',
        notes: c.notes || null
      })),
      favorable_findings: parsed.favorable_findings || [],
      denial_reasons: parsed.denial_reasons || [],
      summary: parsed.summary || null,
      count: (parsed.conditions || []).length
    }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });

  } catch (err) {
    console.error('extract-pdf exception:', err.message);
    return new Response(JSON.stringify({ error: 'Something went wrong. Please try again.' }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
}
