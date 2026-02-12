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

console.log("Railway rodando e aguardando usuário do Lovable...");

// Escuta novas sessões criadas
supabase
  .channel("sessions")
  .on(
    "postgres_changes",
    { event: "INSERT", schema: "public", table: "tiktok_sessions" },
    async (payload) => {
      const username = payload.new.username.replace("@", "");
      const sessionId = payload.new.id;

      console.log("Novo usuário solicitado:", username);

      // Se já tinha uma live conectada, desconecta e limpa dados
      if (currentLive) {
        console.log("Desconectando live anterior...");
        currentLive.removeAllListeners();
        currentLive.disconnect();
        
        // Limpa eventos da sessão anterior
        if (currentSessionId) {
          console.log(`Limpando eventos da sessão ${currentSessionId}...`);
          await supabase
            .from("tiktok_events")
            .delete()
            .eq("session_id", currentSessionId);
        }
      }

      // Atualiza sessão atual
      currentSessionId = sessionId;
      currentLive = new WebcastPushConnection(username);
      await currentLive.connect();

      // Atualiza status no Supabase
      await supabase
        .from("tiktok_sessions")
        .update({ status: "connected" })
        .eq("id", sessionId);

      console.log("Conectado na live de:", username);

      // ESCUTAR LIKES
      currentLive.on("like", async (data) => {
        await supabase.from("tiktok_events").insert({
          event_type: "like",
          username: data.uniqueId,
          like_count: data.likeCount,
          profile_pic: data.profilePictureUrl,
          session_id: currentSessionId,
          raw_event: data
        });
      });

      // ESCUTAR GIFTS
      currentLive.on("gift", async (data) => {
        await supabase.from("tiktok_events").insert({
          event_type: "gift",
          username: data.uniqueId,
          gift_name: data.giftName,
          gift_value: data.diamondCount,
          profile_pic: data.profilePictureUrl,
          session_id: currentSessionId,
          raw_event: data
        });
      });

      // ESCUTAR FIM DA LIVE
      currentLive.on("streamEnd", async (data) => {
        console.log("🔴 Live encerrada:", data);
        
        // Limpa eventos da sessão
        if (currentSessionId) {
          console.log(`Limpando eventos da sessão ${currentSessionId}...`);
          await supabase
            .from("tiktok_events")
            .delete()
            .eq("session_id", currentSessionId);
        }
        
        // Atualiza status no Supabase
        await supabase
          .from("tiktok_sessions")
          .update({ status: "disconnected" })
          .eq("id", currentSessionId);
        
        currentLive.removeAllListeners();
        currentLive.disconnect();
        currentLive = null;
        currentSessionId = null;
      });

      // Tratamento de erro
      currentLive.on("error", async (err) => {
        console.error("❌ Erro na conexão TikTok:", err);
        
        // Limpa eventos em caso de erro
        if (currentSessionId) {
          console.log(`Limpando eventos da sessão ${currentSessionId} por erro...`);
          await supabase
            .from("tiktok_events")
            .delete()
            .eq("session_id", currentSessionId);
        }
        
        currentLive.removeAllListeners();
        currentLive.disconnect();
        currentLive = null;
        currentSessionId = null;
      });

      console.log("Eventos sendo enviados ao Supabase...");
    }
  )
  .subscribe();
