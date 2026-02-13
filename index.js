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
let currentStreamerUsername = null;
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

// Configuração de gifts para roleta (busca dinâmica do banco)
let configuredGiftIds = new Set();
let configuredGiftNames = new Set();

console.log("🚀 Railway iniciado - Sistema de Batalhas VS + Roleta Multi-Gifts");
console.log("📡 Escutando INSERTs e UPDATEs na tabela tiktok_sessions");

// Carrega gifts configurados do banco
async function loadConfiguredGifts(streamerUsername) {
  try {
    console.log(`🔄 Carregando gifts configurados para ${streamerUsername}...`);
    
    const { data: configs, error: configError } = await supabase
      .from("heartme_gift_config")
      .select(`
        gift_id,
        tiktok_gifts(
          gift_id,
          name_en,
          name_pt,
          name_es,
          name_br,
          value
        )
      `)
      .eq("streamer_username", streamerUsername);

    if (configError) {
      console.error("❌ Erro ao buscar gifts configurados:", configError.message);
      return;
    }

    if (!configs || configs.length === 0) {
      console.log("ℹ️ Nenhum gift configurado. Usando Heart Me (ID: 5281) como padrão.");
      configuredGiftIds = new Set([5281]);
      configuredGiftNames = new Set(["Heart Me", "Coração"]);
      return;
    }

    configuredGiftIds = new Set();
    configuredGiftNames = new Set();

    configs.forEach(config => {
      const gift = config.tiktok_gifts;
      if (gift) {
        configuredGiftIds.add(gift.gift_id);
        configuredGiftNames.add(gift.name_en);
        if (gift.name_pt) configuredGiftNames.add(gift.name_pt);
        if (gift.name_es) configuredGiftNames.add(gift.name_es);
        if (gift.name_br) configuredGiftNames.add(gift.name_br);
        
        console.log(`✅ Gift configurado: ${gift.name_pt || gift.name_en} (ID: ${gift.gift_id}, ${gift.value} diamantes)`);
      }
    });

    console.log(`🎯 Total de gifts configurados: ${configuredGiftIds.size}`);
    
  } catch (error) {
    console.error("❌ Erro ao carregar gifts configurados:", error);
    configuredGiftIds = new Set([5281]);
    configuredGiftNames = new Set(["Heart Me", "Coração"]);
  }
}

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
      console.log(`🧹 Limpando eventos da sessão ${currentSessionId}...`);
      await supabase
        .from("tiktok_events")
        .delete()
        .eq("session_id", currentSessionId);
      
      console.log(`✅ Sessão ${currentSessionId} desconectada`);
      currentSessionId = null;
      currentStreamerUsername = null;
      configuredGiftIds.clear();
      configuredGiftNames.clear();
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
  if (currentLive) {
    await cleanupSession();
  }

  try {
    await supabase.from("tiktok_sessions").update({ status: "connecting" }).eq("id", sessionId);
    currentSessionId = sessionId;
    currentStreamerUsername = username.replace("@", "");
    currentLive = new WebcastPushConnection(username);
    
    console.log(`🔌 Conectando em @${username}...`);
    await currentLive.connect();
    
    await loadConfiguredGifts(currentStreamerUsername);
    
    await supabase.from("tiktok_sessions").update({ status: "connected" }).eq("id", sessionId);
    console.log(`✅ CONECTADO em @${username}!`);
    console.log(`🎯 Gifts configurados: ${Array.from(configuredGiftIds).join(', ')}`);
    resetBattleState();

    currentLive.on("gift", async (data) => {
      const giftId = data.giftId;
      const giftName = data.giftName || "";
      
      console.log(`🎁 Gift recebido: ${data.uniqueId} - ${giftName} (ID: ${giftId}, ${data.diamondCount} diamantes)`);
      
      const isConfiguredGift = 
        configuredGiftIds.has(giftId) || 
        configuredGiftNames.has(giftName) ||
        Array.from(configuredGiftNames).some(name => 
          giftName.toLowerCase().includes(name.toLowerCase())
        );
      
      if (isConfiguredGift) {
        console.log(`🎯 GIFT CONFIGURADO DETECTADO de ${data.uniqueId}!`);
        
        await supabase.from("tiktok_events").insert({
          event_type: "heartme",
          username: data.uniqueId,
          gift_name: giftName,
          gift_value: data.diamondCount,
          profile_pic: data.profilePictureUrl,
          session_id: currentSessionId,
          raw_event: {
            ...data,
            detected_by: configuredGiftIds.has(giftId) ? "gift_id" : "gift_name"
          }
        });
      } else {
        await supabase.from("tiktok_events").insert({
          event_type: "gift",
          username: data.uniqueId,
          gift_name: giftName,
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
    currentStreamerUsername = null;
  }
}

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

// ESCUTA UPDATEs (desconexões manuais)
supabase
  .channel("sessions-update")
  .on(
    "postgres_changes",
    { event: "UPDATE", schema: "public", table: "tiktok_sessions" },
    async (payload) => {
      if (payload.new.status === "disconnected" && currentSessionId === payload.new.id) {
        console.log(`🔌 Sessão ${payload.new.id} desconectada manualmente via Lovable`);
        await cleanupSession();
      }
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
    const { data: sessions, error } = await supabase
      .from("tiktok_sessions")
      .select("*")
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(1);

    if (error) throw error;

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
