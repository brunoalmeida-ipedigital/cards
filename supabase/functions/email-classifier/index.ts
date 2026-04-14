/**
 * email-classifier — Supabase Edge Function
 *
 * Fluxo:
 *  1. Busca novos e-mails do Gmail via OAuth (polling)
 *  2. Para cada e-mail, envia o Master Prompt ao OpenRouter (modelo gratuito)
 *  3. Parseia o JSON de triagem retornado pela IA
 *  4. Salva na tabela `emails_triados`
 *  5. Se prioridade = Alta | Crítica → cria card automaticamente no Pipefy
 *
 * Variáveis de ambiente necessárias no Supabase:
 *   GMAIL_CLIENT_ID
 *   GMAIL_CLIENT_SECRET
 *   GMAIL_REFRESH_TOKEN
 *   OPENROUTER_API_KEY
 *   PIPEFY_TOKEN
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   PIPEFY_PIPE_ID        (ID do pipe destino, ex: "823783")
 *   PIPEFY_PHASE_ID       (ID da fase "Caixa de entrada")
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ── Master Prompt para triagem de e-mail ──────────────────────────────
const MASTER_PROMPT = `Você é um Analista de Triagem Nível Sênior de um NOC de atendimento de TI/Sistemas. Sua função é ler e-mails de clientes, extrair os dados vitais e formatá-los estritamente em um JSON estruturado.

DIRETRIZES:
- Seja extremamente conciso. Não adicione saudações.
- Se uma informação não estiver presente no e-mail, preencha o campo com "N/A" ou null. NÃO invente dados.
- Para a "categoria_sistema", classifique apenas dentro destas opções: [PJBank, TEF, NFe, Boleto Fácil, Outros].
- Analise o tom do cliente (Sentimento) para definir a urgência.

FORMATO DE SAÍDA OBRIGATÓRIO (Apenas JSON, sem markdown extra, sem blocos de código):
{
  "analise_thread": {
    "tipo": "novo ou continuacao",
    "motivo_classificacao": "Breve explicação do porquê definiu como novo ou continuação"
  },
  "dados_cliente": {
    "nome": "Nome identificado",
    "email_origem": "Email do remetente"
  },
  "contexto": {
    "categoria_sistema": "Sistema identificado",
    "resumo_problema": "Resumo em até 2 linhas do que o cliente precisa",
    "interacoes_anteriores": "Resumo das mensagens passadas (se houver histórico na thread)"
  },
  "triagem": {
    "sentimento_cliente": "Calmo ou Duvida ou Urgente ou Irritado",
    "prioridade_sugerida": "Baixa ou Media ou Alta ou Critica",
    "acao_recomendada": "O que o analista deve fazer primeiro"
  }
}`;

// ── Helpers ───────────────────────────────────────────────────────────

/** Obtém um access_token do Gmail via refresh_token */
async function getGmailAccessToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`Gmail token error: ${await res.text()}`);
  const data = await res.json();
  return data.access_token;
}

/** Busca IDs dos últimos e-mails não lidos da caixa de entrada */
async function fetchUnreadMessageIds(accessToken: string): Promise<string[]> {
  const url =
    "https://gmail.googleapis.com/gmail/v1/users/me/messages?q=is:unread+in:inbox&maxResults=20";
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Gmail list error: ${await res.text()}`);
  const data = await res.json();
  return (data.messages || []).map((m: { id: string }) => m.id);
}

/** Busca o conteúdo completo de um e-mail */
async function fetchMessage(
  accessToken: string,
  messageId: string,
): Promise<{ id: string; threadId: string; subject: string; from: string; body: string }> {
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!res.ok) throw new Error(`Gmail fetch error: ${await res.text()}`);
  const msg = await res.json();

  const headers = msg.payload?.headers || [];
  const getHeader = (name: string) =>
    headers.find((h: { name: string; value: string }) => h.name.toLowerCase() === name.toLowerCase())?.value || "";

  const subject = getHeader("Subject") || "(Sem assunto)";
  const from = getHeader("From") || "";

  // Extrai corpo do texto plano
  const extractBody = (payload: any): string => {
    if (!payload) return "";
    if (payload.body?.data) {
      return atob(payload.body.data.replace(/-/g, "+").replace(/_/g, "/"));
    }
    if (payload.parts) {
      for (const part of payload.parts) {
        if (part.mimeType === "text/plain" && part.body?.data) {
          return atob(part.body.data.replace(/-/g, "+").replace(/_/g, "/"));
        }
      }
      // Fallback para html
      for (const part of payload.parts) {
        const txt = extractBody(part);
        if (txt) return txt;
      }
    }
    return "";
  };

  const body = extractBody(msg.payload).slice(0, 3000); // Limite de 3k chars para a IA

  return { id: messageId, threadId: msg.threadId, subject, from, body };
}

/** Envia o e-mail para o OpenRouter e retorna a triagem como objeto */
async function classifyEmail(
  apiKey: string,
  subject: string,
  body: string,
  threadHistory = "",
): Promise<any> {
  const userPrompt = `<email_subject>${subject}</email_subject>
<email_body>${body}</email_body>
<thread_history>${threadHistory || "Nenhum histórico anterior."}</thread_history>`;

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://central-atendimentos.app",
      "X-Title": "Central de Atendimentos",
    },
    body: JSON.stringify({
      model: "google/gemma-3-27b-it:free", // Modelo gratuito
      messages: [
        { role: "system", content: MASTER_PROMPT },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.1,
      max_tokens: 800,
    }),
  });

  if (!res.ok) throw new Error(`OpenRouter error: ${await res.text()}`);
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || "{}";

  // Parseia o JSON retornado pela IA (remove possíveis blocos de código markdown)
  const cleaned = content.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
  return JSON.parse(cleaned);
}

/** Cria um card no Pipefy via pipefy-proxy */
async function createPipefyCard(
  pipefyToken: string,
  pipeId: string,
  phaseId: string,
  title: string,
  fields: { fieldId: string; value: string }[],
): Promise<string | null> {
  const fieldsStr = fields
    .map((f) => `{ field_id: "${f.fieldId}", field_value: "${f.value.replace(/"/g, "'")}" }`)
    .join(", ");

  const mutation = `
    mutation {
      createCard(input: {
        pipe_id: "${pipeId}",
        phase_id: "${phaseId}",
        title: "${title.replace(/"/g, "'")}",
        fields_attributes: [${fieldsStr}]
      }) {
        card { id title }
      }
    }`;

  const res = await fetch("https://api.pipefy.com/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${pipefyToken}`,
    },
    body: JSON.stringify({ query: mutation }),
  });

  if (!res.ok) {
    console.error("Pipefy createCard error:", await res.text());
    return null;
  }
  const data = await res.json();
  return data?.data?.createCard?.card?.id || null;
}

/** Marca e-mail como lido no Gmail */
async function markAsRead(accessToken: string, messageId: string) {
  await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/modify`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ removeLabelIds: ["UNREAD"] }),
  });
}

// ── Handler principal ─────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // Carrega variáveis de ambiente
  const GMAIL_CLIENT_ID = Deno.env.get("GMAIL_CLIENT_ID") || "";
  const GMAIL_CLIENT_SECRET = Deno.env.get("GMAIL_CLIENT_SECRET") || "";
  const GMAIL_REFRESH_TOKEN = Deno.env.get("GMAIL_REFRESH_TOKEN") || "";
  const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY") || "";
  const PIPEFY_TOKEN = Deno.env.get("PIPEFY_TOKEN") || "";
  const PIPEFY_PIPE_ID = Deno.env.get("PIPEFY_PIPE_ID") || "823783";
  const PIPEFY_PHASE_ID = Deno.env.get("PIPEFY_PHASE_ID") || ""; // Fase "Caixa de entrada"
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

  if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET || !GMAIL_REFRESH_TOKEN || !OPENROUTER_API_KEY) {
    return new Response(
      JSON.stringify({ error: "Missing required environment variables (Gmail/OpenRouter)" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const results: any[] = [];
  let processed = 0;
  let errors = 0;

  try {
    // 1. Obter access token do Gmail
    const accessToken = await getGmailAccessToken(
      GMAIL_CLIENT_ID,
      GMAIL_CLIENT_SECRET,
      GMAIL_REFRESH_TOKEN,
    );

    // 2. Buscar e-mails não lidos
    const messageIds = await fetchUnreadMessageIds(accessToken);
    console.log(`📧 Encontrados ${messageIds.length} e-mails não lidos`);

    for (const msgId of messageIds) {
      try {
        // Verifica se já foi processado
        const { data: existing } = await supabase
          .from("emails_triados")
          .select("id")
          .eq("gmail_message_id", msgId)
          .maybeSingle();

        if (existing) {
          console.log(`⏭️ E-mail ${msgId} já processado, pulando...`);
          continue;
        }

        // 3. Buscar conteúdo do e-mail
        const email = await fetchMessage(accessToken, msgId);

        // 4. Classificar com IA
        const triagem = await classifyEmail(
          OPENROUTER_API_KEY,
          email.subject,
          email.body,
        );

        const prioridade = triagem?.triagem?.prioridade_sugerida || "Média";
        const categoria = triagem?.contexto?.categoria_sistema || "Outros";
        const nomeCliente = triagem?.dados_cliente?.nome || email.from;

        // 5. Salvar no banco
        const row = {
          gmail_message_id: email.id,
          gmail_thread_id: email.threadId,
          assunto: email.subject,
          corpo: email.body.slice(0, 2000),
          remetente_nome: nomeCliente,
          remetente_email: triagem?.dados_cliente?.email_origem || email.from,
          tipo_thread: triagem?.analise_thread?.tipo || "novo",
          motivo_classificacao: triagem?.analise_thread?.motivo_classificacao || "",
          categoria_sistema: categoria,
          resumo_problema: triagem?.contexto?.resumo_problema || "",
          interacoes_anteriores: triagem?.contexto?.interacoes_anteriores || "",
          sentimento_cliente: triagem?.triagem?.sentimento_cliente || "Calmo",
          prioridade_sugerida: prioridade,
          acao_recomendada: triagem?.triagem?.acao_recomendada || "",
          status: "pendente",
        };

        const { data: inserted, error: dbErr } = await supabase
          .from("emails_triados")
          .insert(row)
          .select()
          .single();

        if (dbErr) {
          console.error("DB insert error:", dbErr.message);
          errors++;
          continue;
        }

        // 6. Criar card no Pipefy automaticamente se Alta ou Crítica
        const autoCreateCard =
          (prioridade === "Alta" || prioridade === "Critica" || prioridade === "Alta" || prioridade === "Crítica") &&
          PIPEFY_PHASE_ID &&
          PIPEFY_TOKEN;

        if (autoCreateCard) {
          const cardTitle = `${categoria} — ${nomeCliente} — ${email.subject.slice(0, 40)}`;
          const cardId = await createPipefyCard(
            PIPEFY_TOKEN,
            PIPEFY_PIPE_ID,
            PIPEFY_PHASE_ID,
            cardTitle,
            [
              // Adapte os field_ids conforme seu Pipefy
              // { fieldId: "nome_do_cliente", value: nomeCliente },
              // { fieldId: "categoria_chamado", value: categoria },
            ],
          );

          if (cardId) {
            await supabase
              .from("emails_triados")
              .update({ pipefy_card_id: cardId, status: "processado" })
              .eq("id", inserted.id);
            console.log(`✅ Card Pipefy criado: ${cardId}`);
          }
        }

        // 7. Marcar e-mail como lido
        await markAsRead(accessToken, msgId);

        results.push({ msgId, prioridade, categoria, cardCriado: !!inserted?.pipefy_card_id });
        processed++;
      } catch (emailErr: unknown) {
        const msg = emailErr instanceof Error ? emailErr.message : String(emailErr);
        console.error(`Erro ao processar e-mail ${msgId}:`, msg);
        errors++;
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        processados: processed,
        erros: errors,
        detalhes: results,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error("email-classifier fatal error:", msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
