import { WebcastPushConnection } from "tiktok-live-connector";
import { createClient } from "@supabase/supabase-js";

// Validação das variáveis de ambiente
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
let battleState = {
  participantA: null,   // Host (sempre à esquerda)
  participantB: null,   // Oponente (sempre à direita)
  heartsA: 5,
  heartsB: 5,
  scoreA: 0,
  scoreB: 0,
  roundStarted: false,
  lastArmyUpdate: 0,
  roundProcessed: false,
  battleStartTime: null
};

// Configuração do gift para roleta (Heart Me = giftId 5281)
const HEARTME_GIFT_ID = 5281;
const HEARTME_GIFT_NAME = "Heart Me";

console.log("🚀 Railway iniciado - Sistema de Batalhas VS + Roleta de Gifts");
console.log("📡 Versão: 2.0 - Eventos de batalha e gifts");

// Função para buscar sessão pendente ao iniciar
async function checkPendingSessions() {
  try {
    console.log("🔍 Buscando sessões pendentes...");
    
    const { data: sessions } = await supabase
      .from("tiktok_sessions")
      .select("*")
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(1);

    if (sessions && sessions.length > 0) {
      const session = sessions[0];
      console.log(`✅ Encontrada sessão pendente: ${session.username} (ID: ${session.id})`);
      await connectToLive(session.username.replace("@", ""), session.id);
    } else {
      console.log("ℹ️ Nenhuma sessão pendente encontrada");
    }
  } catch (error) {
    console.error("❌ Erro ao buscar sessões pendentes:", error.message);
  }
}

// Função principal para conectar na live
async function connectToLive(username, sessionId) {
  // Limpa conexão anterior se existir
  if (currentLive) {
    console.log("🔌 Desconectando live anterior...");
    await cleanupSession();
  }

  try {
    // Atualiza status para 'connecting'
    await supabase
      .from("tiktok_sessions")
      .update({ status: "connecting" })
      .eq("id", sessionId);

    currentSessionId = sessionId;
    currentLive = new WebcastPushConnection(username);

    console.log(`🔌 Conectando na live de @${username}...`);
    await currentLive.connect();

    // ✅ Atualiza status para 'connected' APÓS conexão bem-sucedida
    await supabase
      .from("tiktok_sessions")
      .update({ status: "connected" })
      .eq("id", sessionId);

    console.log(`✅ CONECTADO na live de @${username}!`);
    console.log("📡 Aguardando eventos...");

    // Zera estado da batalha
    resetBattleState();

    // ========== ESCUTA DE EVENTOS ==========

    // EVENTO: Like (para debug)
    currentLive.on("like", (data) => {
      console.log(`❤️ Like: ${data.uniqueId} (${data.likeCount}x)`);
    });

    // EVENTO: Gift (para debug e Heart-Me)
    currentLive.on("gift", async (data) => {
      console.log(`🎁 Gift: ${data.uniqueId} - ${data.giftName} (${data.diamondCount} diamantes)`);
      
      // Verifica se é Heart Me para roleta
      const isHeartMe = 
        data.giftId === HEARTME_GIFT_ID || 
        (data.giftName && data.giftName.toLowerCase().includes(HEARTME_GIFT_NAME.toLowerCase()));
      
      if (isHeartMe) {
        console.log(`🎯 HEART-ME DETECTADO de ${data.uniqueId}!`);
        await saveGiftEvent("heartme", data);
      } else {
        await saveGiftEvent("gift", data);
      }
    });

    // EVENTO: Batalha Iniciada (linkMicBattle)
    currentLive.on("linkMicBattle", async (data) => {
      try {
        console.log("⚔️ EVENTO BATALHA INICIADA:");
        console.log(JSON.stringify(data, null, 2));
        
        // Identifica participantes
        const anchorInfo = data.anchorInfo || {};
        const participants = Object.values(anchorInfo).filter(p => p.nickname);
        
        if (participants.length >= 2) {
          battleState.participantA = participants[0]; // Host (primeiro)
          battleState.participantB = participants[1]; // Oponente (segundo)
          battleState.roundStarted = true;
          battleState.battleStartTime = Date.now();
          battleState.lastArmyUpdate = Date.now();
          battleState.roundProcessed = false;
          
          console.log(`👥 Participantes identificados:`);
          console.log(`   A (Host): ${battleState.participantA.nickname}`);
          console.log(`   B (Oponente): ${battleState.participantB.nickname}`);
          
          // Salva evento no Supabase
          await saveBattleEvent("battle_start", {
            participantA: battleState.participantA.nickname,
            participantB: battleState.participantB.nickname,
            roomId: data.roomId,
            timestamp: new Date().toISOString()
          });
        } else {
          console.warn("⚠️ Menos de 2 participantes na batalha");
        }
      } catch (err) {
        console.error("❌ Erro no evento linkMicBattle:", err);
      }
    });

    // EVENTO: Atualização de Pontuação (linkMicArmies)
    currentLive.on("linkMicArmies", async (data) => {
      try {
        if (!battleState.roundStarted) {
          console.log("ℹ️ Atualização de exército recebida, mas batalha não iniciada");
          return;
        }
        
        const oldScoreA = battleState.scoreA;
        const oldScoreB = battleState.scoreB;
        
        battleState.scoreA = data.audienceCount1 || 0;
        battleState.scoreB = data.audienceCount2 || 0;
        battleState.lastArmyUpdate = Date.now();
        
        console.log(`📊 PONTUAÇÃO ATUALIZADA:`);
        console.log(`   ${battleState.participantA?.nickname || 'A'}: ${oldScoreA} → ${battleState.scoreA}`);
        console.log(`   ${battleState.participantB?.nickname || 'B'}: ${oldScoreB} → ${battleState.scoreB}`);
        
        // Salva atualização de scores
        await saveBattleEvent("battle_score", {
          scoreA: battleState.scoreA,
          scoreB: battleState.scoreB,
          timestamp: new Date().toISOString()
        });
        
        // Verifica fim de round após 15s de inatividade
        setTimeout(async () => {
          if (battleState.roundStarted && 
              !battleState.roundProcessed && 
              Date.now() - battleState.lastArmyUpdate > 15000) {
            console.log("⏰ Timeout de 15s atingido - Processando fim de round...");
            await processBattleRoundEnd();
          }
        }, 15000);
        
      } catch (err) {
        console.error("❌ Erro no evento linkMicArmies:", err);
      }
    });

    // EVENTO: Resultado da Batalha (linkMicMethod)
    currentLive.on("linkMicMethod", async (data) => {
      try {
        if (battleState.roundProcessed) {
          console.log("ℹ️ Resultado já processado, ignorando...");
          return;
        }
        
        console.log(`🏆 RESULTADO DA BATALHA: ${data.win ? 'VITÓRIA' : 'DERROTA'}`);
        
        // Deduz coração baseado no resultado
        if (data.win) {
          // Host venceu -> oponente perde coração
          battleState.heartsB = Math.max(0, battleState.heartsB - 1);
          console.log(`💔 Oponente perdeu 1 coração (${battleState.heartsB} restantes)`);
        } else {
          // Host perdeu -> host perde coração
          battleState.heartsA = Math.max(0, battleState.heartsA - 1);
          console.log(`💔 Host perdeu 1 coração (${battleState.heartsA} restantes)`);
        }
        
        battleState.roundProcessed = true;
        
        // Salva resultado
        await saveBattleEvent("battle_result", {
          winner: data.win ? "participantA" : "participantB",
          heartsA: battleState.heartsA,
          heartsB: battleState.heartsB,
          timestamp: new Date().toISOString()
        });
        
        // Verifica fim de jogo
        if (battleState.heartsA === 0 || battleState.heartsB === 0) {
          const winner = battleState.heartsA === 0 ? "participantB" : "participantA";
          console.log(`🎮 BATALHA ENCERRADA - Vencedor: ${winner}`);
          
          await saveBattleEvent("battle_end", {
            winner,
            finalHeartsA: battleState.heartsA,
            finalHeartsB: battleState.heartsB,
            timestamp: new Date().toISOString()
          });
          
          resetBattleState();
        }
        
      } catch (err) {
        console.error("❌ Erro no evento linkMicMethod:", err);
      }
    });

    // EVENTO: Fim da Live
    currentLive.on("streamEnd", async (data) => {
      console.log(`🔴 LIVE ENCERRADA: ${username}`);
      console.log(JSON.stringify(data, null, 2));
      await cleanupSession();
    });

    // EVENTO: Erro
    currentLive.on("error", async (err) => {
      console.error(`❌ ERRO NA CONEXÃO TikTok para ${username}:`, err);
      await cleanupSession();
    });

    // EVENTO: Chat (para debug)
    currentLive.on("chat", (data) => {
      console.log(`💬 Chat: ${data.uniqueId}: ${data.comment}`);
    });

    // EVENTO: Follow (para debug)
    currentLive.on("follow", (data) => {
      console.log(`➕ Follow: ${data.uniqueId}`);
    });

    // EVENTO: Share (para debug)
    currentLive.on("social", (data) => {
      if (data.displayType === 'share') {
        console.log(`📤 Share: ${data.uniqueId}`);
      }
    });

  } catch (error) {
    console.error(`❌ FALHA AO CONECTAR na live de ${username}:`, error);
    
    // Atualiza status para 'error' em caso de falha
    if (currentSessionId) {
      await supabase
        .from("tiktok_sessions")
        .update({ status: "error" })
        .eq("id", currentSessionId);
    }
    
    currentLive = null;
    currentSessionId = null;
  }
}

// Função para salvar evento de batalha
async function saveBattleEvent(eventType, eventData) {
  if (!currentSessionId) {
    console.warn("⚠️ Tentativa de salvar evento sem session_id");
    return;
  }
  
  try {
    // Verifica se a sessão ainda existe
    const {  session } = await supabase
      .from("tiktok_sessions")
      .select("id")
      .eq("id", currentSessionId)
      .single();

    if (!session) {
      console.warn(`⚠️ Sessão ${currentSessionId} não existe mais. Ignorando evento.`);
      return;
    }

    await supabase.from("tiktok_events").insert({
      event_type: "battle",
      username: "battle_system",
      like_count: null,
      gift_name: eventType,
      gift_value: null,
      profile_pic: null,
      session_id: currentSessionId,
      raw_event: {
        type: eventType,
        ...eventData,
        timestamp: new Date().toISOString()
      }
    });
    
    console.log(`✅ Evento de batalha salvo: ${eventType}`);
    
  } catch (error) {
    console.error("❌ Erro ao salvar evento de batalha:", error);
  }
}

// Função para salvar evento de gift
async function saveGiftEvent(eventType, data) {
  if (!currentSessionId) {
    console.warn("⚠️ Tentativa de salvar gift sem session_id");
    return;
  }
  
  try {
    // Verifica se a sessão ainda existe
    const {  session } = await supabase
      .from("tiktok_sessions")
      .select("id")
      .eq("id", currentSessionId)
      .single();

    if (!session) {
      console.warn(`⚠️ Sessão ${currentSessionId} não existe mais. Ignorando gift.`);
      return;
    }

    await supabase.from("tiktok_events").insert({
      event_type: eventType,
      username: data.uniqueId,
      like_count: null,
      gift_name: data.giftName,
      gift_value: data.diamondCount || data.repeatCount,
      profile_pic: data.profilePictureUrl,
      session_id: currentSessionId,
      raw_event: {
        type: eventType,
        giftId: data.giftId,
        giftName: data.giftName,
        diamondCount: data.diamondCount,
        repeatCount: data.repeatCount,
        timestamp: new Date().toISOString()
      }
    });
    
    console.log(`✅ Evento de gift salvo: ${data.giftName || eventType}`);
    
  } catch (error) {
    console.error("❌ Erro ao salvar evento de gift:", error);
  }
}

// Processa fim de round (dedução de corações)
async function processBattleRoundEnd() {
  if (battleState.roundProcessed || !battleState.roundStarted) {
    console.log("ℹ️ Round já processado ou não iniciado");
    return;
  }
  
  battleState.roundProcessed = true;
  
  // Compara scores para deduzir coração
  if (battleState.scoreA > battleState.scoreB) {
    battleState.heartsB = Math.max(0, battleState.heartsB - 1);
    console.log(`💔 Oponente perdeu 1 coração (Score: ${battleState.scoreA} vs ${battleState.scoreB})`);
  } else if (battleState.scoreB > battleState.scoreA) {
    battleState.heartsA = Math.max(0, battleState.heartsA - 1);
    console.log(`💔 Host perdeu 1 coração (Score: ${battleState.scoreA} vs ${battleState.scoreB})`);
  } else {
    console.log(`🤝 Empate no round (Score: ${battleState.scoreA} vs ${battleState.scoreB})`);
  }
  
  // Salva resultado do round
  await saveBattleEvent("battle_round_end", {
    scoreA: battleState.scoreA,
    scoreB: battleState.scoreB,
    heartsA: battleState.heartsA,
    heartsB: battleState.heartsB,
    timestamp: new Date().toISOString()
  });
  
  // Verifica fim de jogo
  if (battleState.heartsA === 0 || battleState.heartsB === 0) {
    const winner = battleState.heartsA === 0 ? "participantB" : "participantA";
    console.log(`🎮 BATALHA ENCERRADA - Vencedor: ${winner}`);
    
    await saveBattleEvent("battle_end", {
      winner,
      finalHeartsA: battleState.heartsA,
      finalHeartsB: battleState.heartsB,
      timestamp: new Date().toISOString()
    });
    
    resetBattleState();
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
  console.log("🔄 Estado da batalha resetado");
}

// Limpa sessão atual
async function cleanupSession() {
  if (currentLive) {
    currentLive.removeAllListeners();
    currentLive.disconnect();
    currentLive = null;
  }
  
  if (currentSessionId) {
    try {
      // ✅ Primeiro deleta os eventos da sessão (evita foreign key violation)
      console.log(`🧹 Limpando eventos da sessão ${currentSessionId}...`);
      await supabase
        .from("tiktok_events")
        .delete()
        .eq("session_id", currentSessionId);
      
      // ✅ Depois atualiza status para 'disconnected'
      console.log(`🔌 Desconectando sessão ${currentSessionId}...`);
      await supabase
        .from("tiktok_sessions")
        .update({ status: "disconnected" })
        .eq("id", currentSessionId);
      
      console.log(`✅ Sessão ${currentSessionId} limpa e desconectada`);
    } catch (error) {
      console.error("❌ Erro ao limpar sessão:", error);
    }
  }
  
  currentSessionId = null;
  resetBattleState();
}

// ========== ESCUTA DE MUDANÇAS NO SUPABASE ==========

// ESCUTA NOVAS SESSÕES (INSERT)
supabase
  .channel("sessions-insert")
  .on(
    "postgres_changes",
    { event: "INSERT", schema: "public", table: "tiktok_sessions" },
    async (payload) => {
      if (payload.new.status === "pending") {
        console.log(`📥 Nova sessão recebida: ${payload.new.username}`);
        await connectToLive(payload.new.username.replace("@", ""), payload.new.id);
      }
    }
  )
  .subscribe();

// ESCUTA ATUALIZAÇÕES DE SESSÃO (para limpeza automática)
supabase
  .channel("sessions-update")
  .on(
    "postgres_changes",
    { event: "UPDATE", schema: "public", table: "tiktok_sessions" },
    async (payload) => {
      if (payload.new.status === "disconnected" && currentSessionId === payload.new.id) {
        console.log(`🔌 Sessão ${payload.new.id} desconectada via Supabase`);
        await cleanupSession();
      }
    }
  )
  .subscribe();

// ========== LIMPEZA AUTOMÁTICA ==========

// Limpeza a cada 30 segundos
setInterval(async () => {
  try {
    console.log("🧹 Executando limpeza automática de sessões antigas...");
    
    // Passo 1: Deletar eventos das sessões antigas
    const { error: eventsError } = await supabase.rpc("cleanup_old_sessions");
    
    if (eventsError) {
      console.error("❌ Erro na limpeza de eventos:", eventsError.message);
    } else {
      console.log("✅ Limpeza de sessões concluída!");
    }
  } catch (error) {
    console.error("❌ Erro na limpeza automática:", error.message);
  }
}, 30000);

// Busca sessões pendentes ao iniciar
checkPendingSessions();

console.log("✅ Railway pronto e aguardando sessões!");
console.log("💡 Dica: Conecte em um streamer que está fazendo BATALHA AGORA");
