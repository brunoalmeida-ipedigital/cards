const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const OPENROUTER_API_KEY = Deno.env.get('OPENROUTER_API_KEY');
  if (!OPENROUTER_API_KEY) {
    return new Response(JSON.stringify({ error: 'OPENROUTER_API_KEY not configured' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await req.json();
    const { action, context } = body;

    if (action === 'summarize_closure') {
      const { classificacao, subcategoria, comentarios, etapas, cliente } = context || {};

      const prompt = `Você é um assistente de suporte técnico. Resuma em 1-2 frases curtas o atendimento concluído abaixo. Seja direto e profissional.

Dados do atendimento:
- Cliente: ${cliente || 'N/A'}
- Classificação: ${classificacao || 'N/A'}
- Subcategoria: ${subcategoria || 'N/A'}
- Etapas percorridas: ${etapas || 'N/A'}
- Comentários: ${comentarios || 'Sem comentários'}

Exemplo de resposta: "Instalação de impressora finalizada com sucesso! Configurados os parâmetros e envio feito corretamente."

Responda apenas com a mensagem de conclusão, sem prefixos.`;

      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
          'HTTP-Referer': 'https://painel-atendimentos.app',
        },
        body: JSON.stringify({
          model: 'meta-llama/llama-3.1-8b-instruct:free',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 200,
          temperature: 0.3,
        }),
      });

      const data = await response.json();
      const message = data?.choices?.[0]?.message?.content?.trim() || 'Atendimento concluído com sucesso.';

      return new Response(JSON.stringify({ message }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (action === 'summarize_email') {
      const { emails, subject, sender } = context || {};

      const prompt = `Você é um assistente de email corporativo. Analise a thread de emails abaixo e forneça:
1. Um resumo conciso do contexto completo
2. Se é um email novo ou continuação de conversa
3. Quais foram as interações principais

Remetente: ${sender || 'Desconhecido'}
Assunto: ${subject || 'Sem assunto'}
Emails na thread:
${Array.isArray(emails) ? emails.map((e: any, i: number) => `--- Email ${i + 1} ---\nDe: ${e.from}\nData: ${e.date}\n${e.body?.slice(0, 500) || e.snippet || ''}`).join('\n\n') : 'Sem conteúdo'}

Responda em JSON: {"summary": "...", "isNew": true/false, "company": "nome da empresa se identificável", "keyPoints": ["ponto1", "ponto2"]}`;

      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
          'HTTP-Referer': 'https://painel-atendimentos.app',
        },
        body: JSON.stringify({
          model: 'meta-llama/llama-3.1-8b-instruct:free',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 500,
          temperature: 0.2,
        }),
      });

      const data = await response.json();
      const content = data?.choices?.[0]?.message?.content?.trim() || '{}';

      let parsed;
      try {
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { summary: content, isNew: true, company: '', keyPoints: [] };
      } catch {
        parsed = { summary: content, isNew: true, company: '', keyPoints: [] };
      }

      return new Response(JSON.stringify(parsed), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ error: 'Unknown action. Use: summarize_closure, summarize_email' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error('OpenRouter proxy error:', msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
