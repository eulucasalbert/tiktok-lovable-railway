import { WebcastPushConnection } from "tiktok-live-connector";
import { createClient } from "@supabase/supabase-js";

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
  console.error("❌ Variáveis de ambiente do Supabase não configuradas!");
  process.exit(1);
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

let currentLive = null;
let currentSessionId = null;

console.log("🚀 Railway rodando e aguardando usuário do Lovable...");

// Função para processar uma sessão
async function processSession(session) {
  const username = session.username.replace("@", "");
  const sessionId = session.id;

  console.log(`🔄 Processando sessão ${sessionId} para usuário: ${username}`);

  try {
    // Verifica se já está conectado em outra live
    if (currentLive) {
      console.log("🔌 Desconectando live anterior...");
      currentLive.removeAllListeners();
      currentLive.disconnect();
      currentLive = null;
      currentSessionId = null;
    }

    // Cria conexão com TikTok
    currentLive = new WebcastPushConnection(username);
    currentSessionId = sessionId;

    // Tenta conectar
    console.log(`🔌 Conectando na live de ${username}...`);
    await currentLive.connect();

    // ✅ ATUALIZA STATUS ANTES DE ESCUTAR EVENTOS
    console.log(`✅ Conectado na live de ${username}`);
    await supabase
      .from("tiktok_sessions")
      .update({ status: "connected" })
      .eq("id", sessionId);

    // ESCUTA LIKES
    currentLive.on("like", async (data) => {
      // ✅ Verifica se session_id ainda existe antes de inserir
      const { data: sessionExists } = await supabase
        .from("tiktok_sessions")
        .select("id")
        .eq("id", currentSessionId)
        .single();

      if (!sessionExists) {
        console.warn(`⚠️ Sessão ${currentSessionId} não existe mais. Ignorando evento.`);
        return;
      }

      try {
        await supabase.from("tiktok_events").insert({
          event_type: "like",
          username: data.uniqueId,
          like_count: data.likeCount,
          profile_pic: data.profilePictureUrl,
          session_id: currentSessionId,
          raw_event: data
        });
        console.log(`❤️ Like recebido: ${data.uniqueId} (${data.likeCount})`);
      } catch (error) {
        console.error("❌ Erro ao salvar like:", error.message);
      }
    });

    // ESCUTA GIFTS
    currentLive.on("gift", async (data) => {
      // ✅ Verifica se session_id ainda existe antes de inserir
      const { data: sessionExists } = await supabase
        .from("tiktok_sessions")
        .select("id")
        .eq("id", currentSessionId)
        .single();

      if (!sessionExists) {
        console.warn(`⚠️ Sessão ${currentSessionId} não existe mais. Ignorando evento.`);
        return;
      }

      try {
        await supabase.from("tiktok_events").insert({
          event_type: "gift",
          username: data.uniqueId,
          gift_name: data.giftName,
          gift_value: data.diamondCount,
          profile_pic: data.profilePictureUrl,
          session_id: currentSessionId,
          raw_event: data
        });
        console.log(`🎁 Gift recebido: ${data.uniqueId} (${data.giftName})`);
      } catch (error) {
        console.error("❌ Erro ao salvar gift:", error.message);
      }
    });

    // ESCUTA FIM DA LIVE
    currentLive.on("streamEnd", async (data) => {
      console.log(`🔴 Live encerrada: ${username}`);
      await cleanupSession();
    });

    // TRATAMENTO DE ERRO
    currentLive.on("error", async (err) => {
      console.error(`❌ Erro na conexão TikTok para ${username}:`, err.message);
      await cleanupSession();
    });

  } catch (error) {
    console.error(`❌ Falha ao conectar na live de ${username}:`, error.message);
    
    // Atualiza status para "error" em caso de falha
    await supabase
      .from("tiktok_sessions")
      .update({ status: "error" })
      .eq("id", sessionId);
    
    currentLive = null;
    currentSessionId = null;
  }
}

// Função para limpar sessão atual
async function cleanupSession() {
  if (currentLive) {
    currentLive.removeAllListeners();
    currentLive.disconnect();
  }
  
  if (currentSessionId) {
    // Atualiza status para "disconnected"
    await supabase
      .from("tiktok_sessions")
      .update({ status: "disconnected" })
      .eq("id", currentSessionId);
  }
  
  currentLive = null;
  currentSessionId = null;
}

// ESCUTA NOVAS SESSÕES (INSERT)
supabase
  .channel("sessions-insert")
  .on(
    "postgres_changes",
    { event: "INSERT", schema: "public", table: "tiktok_sessions" },
    async (payload) => {
      if (payload.new.status === "pending") {
        await processSession(payload.new);
      }
    }
  )
  .subscribe();

// ESCUTA SESSÕES PENDENTES AO INICIAR
(async () => {
  console.log("🔍 Buscando sessões pendentes...");
  const { data: pendingSessions } = await supabase
    .from("tiktok_sessions")
    .select("*")
    .eq("status", "pending")
    .order("created_at", { ascending: true });

  if (pendingSessions && pendingSessions.length > 0) {
    console.log(`🔄 Encontradas ${pendingSessions.length} sessões pendentes`);
    // Processa a sessão mais recente
    await processSession(pendingSessions[pendingSessions.length - 1]);
  } else {
    console.log("✅ Nenhuma sessão pendente encontrada");
  }
})();

console.log("✅ Railway pronto e escutando sessões...");
