const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const GMAIL_API = 'https://www.googleapis.com/gmail/v1/users/me';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

async function getAccessToken(): Promise<string> {
  const clientId = Deno.env.get('GMAIL_CLIENT_ID');
  const clientSecret = Deno.env.get('GMAIL_CLIENT_SECRET');
  const refreshToken = Deno.env.get('GMAIL_REFRESH_TOKEN');

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Gmail OAuth credentials not configured');
  }

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Token refresh failed [${res.status}]: ${errText}`);
  }

  const data = await res.json();
  return data.access_token;
}

function decodeBase64Url(str: string): string {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  try {
    return decodeURIComponent(
      atob(base64)
        .split('')
        .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
        .join('')
    );
  } catch {
    return atob(base64);
  }
}

function getHeader(headers: any[], name: string): string {
  const h = headers?.find((h: any) => h.name?.toLowerCase() === name.toLowerCase());
  return h?.value || '';
}

function extractBody(payload: any): string {
  if (!payload) return '';

  if (payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }

  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return decodeBase64Url(part.body.data);
      }
    }
    for (const part of payload.parts) {
      if (part.mimeType === 'text/html' && part.body?.data) {
        const html = decodeBase64Url(part.body.data);
        return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      }
    }
    for (const part of payload.parts) {
      const nested = extractBody(part);
      if (nested) return nested;
    }
  }

  return '';
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const accessToken = await getAccessToken();
    const body = await req.json();
    const { action, maxResults, threadId } = body;

    const headers = {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    };

    if (action === 'listEmails') {
      const query = body.query || 'to:brunoalmeida@ipe.digital OR from:brunoalmeida@ipe.digital';
      const url = `${GMAIL_API}/messages?maxResults=${maxResults || 20}&q=${encodeURIComponent(query)}`;

      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(`Gmail list failed [${res.status}]`);
      const data = await res.json();
      const messages = data.messages || [];

      // Fetch full details for each message
      const detailed = await Promise.all(
        messages.slice(0, maxResults || 20).map(async (m: any) => {
          const msgRes = await fetch(`${GMAIL_API}/messages/${m.id}?format=full`, { headers });
          if (!msgRes.ok) return null;
          const msg = await msgRes.json();
          const msgHeaders = msg.payload?.headers || [];

          return {
            id: msg.id,
            threadId: msg.threadId,
            snippet: msg.snippet || '',
            from: getHeader(msgHeaders, 'From'),
            to: getHeader(msgHeaders, 'To'),
            subject: getHeader(msgHeaders, 'Subject'),
            date: getHeader(msgHeaders, 'Date'),
            inReplyTo: getHeader(msgHeaders, 'In-Reply-To'),
            body: extractBody(msg.payload)?.slice(0, 1000) || '',
          };
        })
      );

      return new Response(JSON.stringify({ emails: detailed.filter(Boolean) }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (action === 'getThread') {
      if (!threadId) {
        return new Response(JSON.stringify({ error: 'threadId required' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const res = await fetch(`${GMAIL_API}/threads/${threadId}?format=full`, { headers });
      if (!res.ok) throw new Error(`Gmail thread failed [${res.status}]`);
      const thread = await res.json();

      const messages = (thread.messages || []).map((msg: any) => {
        const msgHeaders = msg.payload?.headers || [];
        return {
          id: msg.id,
          from: getHeader(msgHeaders, 'From'),
          to: getHeader(msgHeaders, 'To'),
          subject: getHeader(msgHeaders, 'Subject'),
          date: getHeader(msgHeaders, 'Date'),
          body: extractBody(msg.payload)?.slice(0, 1000) || '',
          snippet: msg.snippet || '',
        };
      });

      return new Response(JSON.stringify({
        threadId: thread.id,
        messageCount: messages.length,
        messages,
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ error: 'Unknown action. Use: listEmails, getThread' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error('Gmail proxy error:', msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
