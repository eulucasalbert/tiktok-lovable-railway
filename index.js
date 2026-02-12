import { WebcastPushConnection } from "tiktok-live-connector";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

let currentLive = null;

console.log("Railway rodando e aguardando usuário do Lovable...");

// Escuta novas sessões criadas no Supabase
supabase
  .channel("sessions")
  .on(
    "postgres_changes",
    { event: "INSERT", schema: "public", table: "tiktok_sessions" },
    async (payload) => {
      const username = payload.new.username.replace("@", "");

      console.log("Novo usuário solicitado:", username);

      // Se já tinha uma live conectada, desconecta
      if (currentLive) {
        console.log("Desconectando live anterior...");
        currentLive.disconnect();
      }

      // Conecta no novo usuário
      currentLive = new WebcastPushConnection(username);
      await currentLive.connect();

      // Atualiza status no Supabase
      await supabase
        .from("tiktok_sessions")
        .update({ status: "connected" })
        .eq("id", payload.new.id);

      console.log("Conectado na live de:", username);

      // ESCUTAR LIKES
      currentLive.on("like", async (data) => {
        await supabase.from("tiktok_events").insert({
          event_type: "like",
          username: data.uniqueId,
          like_count: data.likeCount,
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
          raw_event: data
        });
      });

      console.log("Eventos sendo enviados ao Supabase...");
    }
  )
  .subscribe();
