import { WebcastPushConnection } from "tiktok-live-connector";
import { createClient } from "@supabase/supabase-js";

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
  console.error("❌ Variáveis de ambiente não configuradas!");
  process.exit(1);
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

let currentLive = null;
let currentSessionId = null;
let battleState = {
  participantA: null,
  participantB: null,
  heartsA: 5,
  heartsB: 5,
  scoreA: 0,
  scoreB: 0,
  roundStarted: false,
  lastArmyUpdate: 0,
  roundProcessed: false,
  battleStartTime: null
};

const HEARTME_GIFT_ID = 5281;
const HEARTME_GIFT_NAME = "Heart Me";

console.log("🚀 Railway iniciado - Sistema de Batalhas VS + Roleta");
console.log("📡 Escutando INSERTs e UPDATEs na tabela tiktok_sessions");

// Limpa sessão atual
async function cleanupSession() {
  if (currentLive) {
    console.log("🔌 Desconectando live...");
    currentLive.removeAllListeners();
    currentLive.disconnect();
    currentLive = null;
  }
  
  if (currentSessionId) {
    try {
      // Primeiro deleta eventos (evita FK violation)
      console.log(`🧹 Limpando eventos da sessão ${currentSessionId}...`);
      await supabase
        .from("tiktok_events")
        .delete()
        .eq("session_id", currentSessionId);
      
      // Depois atualiza status para disconnected
      console.log(`✅ Sessão ${currentSessionId} desconectada`);
      currentSessionId = null;
      resetBattleState();
    } catch (error) {
      console.error("❌ Erro ao limpar sessão:", error.message);
    }
  }
}

// Reseta estado da batalha
function resetBattleState() {
  battleState = {
    participantA: null,
    participantB: null,
    heartsA: 5,
    heartsB: 5,
    scoreA: 0,
    scoreB: 0,
    roundStarted: false,
    lastArmyUpdate: 0,
    roundProcessed: false,
    battleStartTime: null
  };
}

// Conecta na live
async function connectToLive(username, sessionId) {
  // Limpa conexão anterior
  if (currentLive) {
    await cleanupSession();
  }

  try {
    await supabase.from("tiktok_sessions").update({ status: "connecting" }).eq("id", sessionId);
    currentSessionId = sessionId;
    currentLive = new WebcastPushConnection(username);
    
    console.log(`🔌 Conectando em @${username}...`);
    await currentLive.connect();
    
    await supabase.from("tiktok_sessions").update({ status: "connected" }).eq("id", sessionId);
    console.log(`✅ CONECTADO em @${username}!`);
    resetBattleState();

    // ========== ESCUTA DE EVENTOS ==========
    
    currentLive.on("gift", async (data) => {
      console.log(`🎁 Gift: ${data.uniqueId} - ${data.giftName} (ID: ${data.giftId})`);
      
      if (data.giftId === HEARTME_GIFT_ID || 
          (data.giftName && data.giftName.toLowerCase().includes(HEARTME_GIFT_NAME.toLowerCase()))) {
        console.log(`🎯 HEART-ME DETECTADO de ${data.uniqueId}!`);
        
        await supabase.from("tiktok_events").insert({
          event_type: "heartme",
          username: data.uniqueId,
          gift_name: data.giftName,
          gift_value: data.diamondCount,
          profile_pic: data.profilePictureUrl,
          session_id: currentSessionId,
          raw_event: data
        });
      } else {
        await supabase.from("tiktok_events").insert({
          event_type: "gift",
          username: data.uniqueId,
          gift_name: data.giftName,
          gift_value: data.diamondCount,
          profile_pic: data.profilePictureUrl,
          session_id: currentSessionId,
          raw_event: data
        });
      }
    });

    currentLive.on("linkMicBattle", async (data) => {
      console.log("⚔️ BATALHA INICIADA");
      
      const anchorInfo = data.anchorInfo || {};
      const participants = Object.values(anchorInfo).filter(p => p.nickname);
      
      if (participants.length >= 2) {
        battleState.participantA = participants[0];
        battleState.participantB = participants[1];
        battleState.roundStarted = true;
        battleState.battleStartTime = Date.now();
        battleState.lastArmyUpdate = Date.now();
        battleState.roundProcessed = false;
        
        console.log(`👥 Participantes: ${battleState.participantA.nickname} vs ${battleState.participantB.nickname}`);
        
        await supabase.from("tiktok_events").insert({
          event_type: "battle",
          username: "battle_system",
          session_id: currentSessionId,
          raw_event: {
            type: "battle_start",
            participantA: battleState.participantA.nickname,
            participantB: battleState.participantB.nickname,
            roomId: data.roomId,
            timestamp: new Date().toISOString()
          }
        });
      }
    });

    currentLive.on("linkMicArmies", async (data) => {
      if (!battleState.roundStarted) return;
      
      const oldA = battleState.scoreA;
      const oldB = battleState.scoreB;
      
      battleState.scoreA = data.audienceCount1 || 0;
      battleState.scoreB = data.audienceCount2 || 0;
      battleState.lastArmyUpdate = Date.now();
      
      console.log(`📊 Score: ${oldA}→${battleState.scoreA} vs ${oldB}→${battleState.scoreB}`);
      
      await supabase.from("tiktok_events").insert({
        event_type: "battle",
        username: "battle_system",
        session_id: currentSessionId,
        raw_event: {
          type: "battle_score",
          scoreA: battleState.scoreA,
          scoreB: battleState.scoreB,
          timestamp: new Date().toISOString()
        }
      });
    });

    currentLive.on("streamEnd", async () => {
      console.log("🔴 Live encerrada");
      await cleanupSession();
    });

    currentLive.on("error", async (err) => {
      console.error("❌ Erro na conexão:", err.message);
      await cleanupSession();
    });

  } catch (error) {
    console.error(`❌ Falha ao conectar:`, error.message);
    if (currentSessionId) {
      await supabase.from("tiktok_sessions").update({ status: "error" }).eq("id", currentSessionId);
    }
    currentLive = null;
    currentSessionId = null;
  }
}

// ========== ESCUTA DE MUDANÇAS NO SUPABASE ==========

// ESCUTA INSERTs (novas sessões)
supabase
  .channel("sessions-insert")
  .on(
    "postgres_changes",
    { event: "INSERT", schema: "public", table: "tiktok_sessions" },
    async (payload) => {
      if (payload.new.status === "pending") {
        console.log(`📥 Nova sessão: ${payload.new.username}`);
        await connectToLive(payload.new.username.replace("@", ""), payload.new.id);
      }
    }
  )
  .subscribe();

// ✅ ESCUTA UPDATEs (desconexões manuais) - CORREÇÃO PRINCIPAL!
supabase
  .channel("sessions-update")
  .on(
    "postgres_changes",
    { event: "UPDATE", schema: "public", table: "tiktok_sessions" },
    async (payload) => {
      // Verifica se foi atualizado para "disconnected"
      if (payload.new.status === "disconnected" && currentSessionId === payload.new.id) {
        console.log(`🔌 Sessão ${payload.new.id} desconectada manualmente via Lovable`);
        await cleanupSession();
      }
      // Verifica se foi atualizado para "error"
      else if (payload.new.status === "error" && currentSessionId === payload.new.id) {
        console.log(`⚠️ Sessão ${payload.new.id} marcada como erro`);
        await cleanupSession();
      }
    }
  )
  .subscribe();

// Busca sessões pendentes ao iniciar
(async () => {
  try {
    console.log("🔍 Buscando sessões pendentes...");
    const {  sessions } = await supabase
      .from("tiktok_sessions")
      .select("*")
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(1);

    if (sessions?.length > 0) {
      console.log(`✅ Conectando em: ${sessions[0].username}`);
      await connectToLive(sessions[0].username.replace("@", ""), sessions[0].id);
    } else {
      console.log("ℹ️ Nenhuma sessão pendente encontrada");
    }
  } catch (error) {
    console.error("❌ Erro ao buscar sessões:", error.message);
  }
})();

console.log("✅ Railway pronto!");
