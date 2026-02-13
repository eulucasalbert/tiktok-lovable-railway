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
  roundProcessed: false
};

// Configuração do gift para roleta (padrão: Heart Me = giftId 5281)
const HEARTME_GIFT_ID = 5281;
const HEARTME_GIFT_NAME = "Heart Me";

console.log("🚀 Railway rodando - Sistema de Batalhas VS + Roleta de Gifts");

// Função para processar sessão pendente
async function processPendingSession() {
  try {
    // Busca a sessão mais recente com status 'pending'
    const { data: session } = await supabase
      .from("tiktok_sessions")
      .select("*")
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (!session) {
      console.log("🔍 Nenhuma sessão pendente encontrada");
      return;
    }

    console.log(`🔄 Processando sessão pendente: ${session.username} (ID: ${session.id})`);
    await connectToLive(session.username.replace("@", ""), session.id);
    
  } catch (error) {
    console.error("❌ Erro ao buscar sessões pendentes:", error.message);
  }
}

// Função para conectar na live do TikTok
async function connectToLive(username, sessionId) {
  // Limpa conexão anterior se existir
  if (currentLive) {
    console.log("🔌 Desconectando live anterior...");
    currentLive.removeAllListeners();
    currentLive.disconnect();
    currentLive = null;
    currentSessionId = null;
  }

  try {
    // Atualiza status para 'connecting' ANTES de tentar conectar
    await supabase
      .from("tiktok_sessions")
      .update({ status: "connecting" })
      .eq("id", sessionId);

    currentSessionId = sessionId;
    currentLive = new WebcastPushConnection(username);

    console.log(`🔌 Conectando na live de @${username}...`);
    await currentLive.connect();

    // ✅ Atualiza status para 'connected' SOMENTE após conexão bem-sucedida
    await supabase
      .from("tiktok_sessions")
      .update({ status: "connected" })
      .eq("id", sessionId);

    console.log(`✅ Conectado na live de @${username}`);

    // Zera estado da batalha ao conectar
    resetBattleState();

    // ESCUTA EVENTOS DE BATALHA
    currentLive.on("linkMicBattle", async (data) => {
      try {
        console.log("⚔️ Batalha iniciada:", data);
        
        // Identifica participantes (host sempre é participantA)
        const anchorInfo = data.anchorInfo || {};
        const participants = Object.values(anchorInfo).filter(p => p.nickname);
        
        if (participants.length >= 2) {
          battleState.participantA = participants[0]; // Host (sempre primeiro)
          battleState.participantB = participants[1]; // Oponente
          battleState.roundStarted = true;
          battleState.lastArmyUpdate = Date.now();
          battleState.roundProcessed = false;
          
          // Salva evento de batalha no Supabase
          await saveBattleEvent("battle_start", {
            participantA: battleState.participantA.nickname,
            participantB: battleState.participantB.nickname,
            roomId: data.roomId
          });
        }
      } catch (err) {
        console.error("❌ Erro no evento linkMicBattle:", err.message);
      }
    });

    // ESCUTA ATUALIZAÇÕES DE PONTUAÇÃO
    currentLive.on("linkMicArmies", async (data) => {
      try {
        if (!battleState.roundStarted) return;
        
        battleState.lastArmyUpdate = Date.now();
        battleState.scoreA = data.audienceCount1 || 0;
        battleState.scoreB = data.audienceCount2 || 0;
        
        console.log(`📊 Pontuação: ${battleState.scoreA} vs ${battleState.scoreB}`);
        
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
            await processBattleRoundEnd();
          }
        }, 15000);
        
      } catch (err) {
        console.error("❌ Erro no evento linkMicArmies:", err.message);
      }
    });

    // ESCUTA RESULTADO DA BATALHA
    currentLive.on("linkMicMethod", async (data) => {
      try {
        if (battleState.roundProcessed) return;
        
        console.log(`🏆 Resultado da batalha: ${data.win ? 'Vitória' : 'Derrota'}`);
        
        // Deduz coração baseado no resultado
        if (data.win) {
          // Host venceu -> oponente perde coração
          battleState.heartsB = Math.max(0, battleState.heartsB - 1);
        } else {
          // Host perdeu -> host perde coração
          battleState.heartsA = Math.max(0, battleState.heartsA - 1);
        }
        
        battleState.roundProcessed = true;
        
        // Salva resultado
        await saveBattleEvent("battle_result", {
          winner: data.win ? "participantA" : "participantB",
          heartsA: battleState.heartsA,
          heartsB: battleState.heartsB
        });
        
        // Verifica fim de jogo
        if (battleState.heartsA === 0 || battleState.heartsB === 0) {
          await saveBattleEvent("battle_end", {
            winner: battleState.heartsA === 0 ? "participantB" : "participantA",
            finalHeartsA: battleState.heartsA,
            finalHeartsB: battleState.heartsB
          });
          resetBattleState();
        }
        
      } catch (err) {
        console.error("❌ Erro no evento linkMicMethod:", err.message);
      }
    });

    // ESCUTA GIFTs PARA ROLETA (Heart-Me)
    currentLive.on("gift", async (data) => {
      try {
        // Verifica se é o gift configurado para roleta
        const isHeartMe = 
          data.giftId === HEARTME_GIFT_ID || 
          data.giftName?.toLowerCase().includes(HEARTME_GIFT_NAME.toLowerCase());
        
        if (isHeartMe) {
          console.log(`🎁 Heart-Me recebido de ${data.uniqueId} (${data.repeatCount || 1}x)`);
          
          // Salva evento de gift para roleta
          await saveGiftEvent("heartme", {
            username: data.uniqueId,
            giftName: data.giftName,
            giftId: data.giftId,
            repeatCount: data.repeatCount || 1,
            profilePictureUrl: data.profilePictureUrl
          });
        } else {
          // Salva outros gifts normalmente
          await saveGiftEvent("gift", {
            username: data.uniqueId,
            giftName: data.giftName,
            giftId: data.giftId,
            diamondCount: data.diamondCount,
            repeatCount: data.repeatCount || 1,
            profilePictureUrl: data.profilePictureUrl
          });
        }
      } catch (err) {
        console.error("❌ Erro no evento gift:", err.message);
      }
    });

    // ESCUTA FIM DA LIVE
    currentLive.on("streamEnd", async (data) => {
      console.log(`🔴 Live encerrada: ${username}`);
      await cleanupSession();
    });

    // TRATAMENTO DE ERROS
    currentLive.on("error", async (err) => {
      console.error(`❌ Erro na conexão TikTok para ${username}:`, err.message);
      await cleanupSession();
    });

  } catch (error) {
    console.error(`❌ Falha ao conectar na live de ${username}:`, error.message);
    
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
  if (!currentSessionId) return;
  
  try {
    // Verifica se a sessão ainda existe
    const { data: sessionExists } = await supabase
      .from("tiktok_sessions")
      .select("id")
      .eq("id", currentSessionId)
      .single();

    if (!sessionExists) {
      console.warn(`⚠️ Sessão ${currentSessionId} não existe mais. Ignorando evento de batalha.`);
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
    console.error("❌ Erro ao salvar evento de batalha:", error.message);
  }
}

// Função para salvar evento de gift
async function saveGiftEvent(eventType, eventData) {
  if (!currentSessionId) return;
  
  try {
    // Verifica se a sessão ainda existe
    const { data: sessionExists } = await supabase
      .from("tiktok_sessions")
      .select("id")
      .eq("id", currentSessionId)
      .single();

    if (!sessionExists) {
      console.warn(`⚠️ Sessão ${currentSessionId} não existe mais. Ignorando evento de gift.`);
      return;
    }

    await supabase.from("tiktok_events").insert({
      event_type: eventType,
      username: eventData.username,
      like_count: eventType === "like" ? eventData.likeCount : null,
      gift_name: eventData.giftName,
      gift_value: eventData.diamondCount || eventData.repeatCount,
      profile_pic: eventData.profilePictureUrl,
      session_id: currentSessionId,
      raw_event: {
        type: eventType,
        ...eventData,
        timestamp: new Date().toISOString()
      }
    });
    
    console.log(`✅ Evento de gift salvo: ${eventData.giftName || eventType}`);
    
  } catch (error) {
    console.error("❌ Erro ao salvar evento de gift:", error.message);
  }
}

// Processa fim de round (dedução de corações)
async function processBattleRoundEnd() {
  if (battleState.roundProcessed || !battleState.roundStarted) return;
  
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
    heartsB: battleState.heartsB
  });
  
  // Verifica fim de jogo
  if (battleState.heartsA === 0 || battleState.heartsB === 0) {
    await saveBattleEvent("battle_end", {
      winner: battleState.heartsA === 0 ? "participantB" : "participantA",
      finalHeartsA: battleState.heartsA,
      finalHeartsB: battleState.heartsB
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
    roundProcessed: false
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
    // ✅ Primeiro deleta os eventos da sessão (evita foreign key violation)
    await supabase
      .from("tiktok_events")
      .delete()
      .eq("session_id", currentSessionId);
    
    // ✅ Depois atualiza status para 'disconnected'
    await supabase
      .from("tiktok_sessions")
      .update({ status: "disconnected" })
      .eq("id", currentSessionId);
    
    console.log(`🧹 Sessão ${currentSessionId} limpa e desconectada`);
  }
  
  currentSessionId = null;
  resetBattleState();
}

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

// Busca sessões pendentes ao iniciar
processPendingSession();

// Limpeza automática a cada 30 segundos (sessões desconectadas/pending antigas)
setInterval(async () => {
  try {
    console.log("🧹 Executando limpeza automática de sessões...");
    
    // Passo 1: Deletar eventos das sessões antigas
    await supabase.rpc("cleanup_old_sessions");
    
    console.log("✅ Limpeza concluída!");
  } catch (error) {
    console.error("❌ Erro na limpeza automática:", error.message);
  }
}, 30000);

// Função RPC para limpeza (crie no Supabase)
console.log("💡 Execute esta função no SQL Editor do Supabase:");
console.log(`
CREATE OR REPLACE FUNCTION cleanup_old_sessions()
RETURNS void AS $$
BEGIN
  -- Deleta eventos das sessões antigas primeiro
  DELETE FROM tiktok_events 
  WHERE session_id IN (
    SELECT id FROM tiktok_sessions 
    WHERE (status = 'disconnected' OR status = 'pending' OR status = 'error')
      AND created_at < NOW() - INTERVAL '30 seconds'
  );
  
  -- Depois deleta as sessões
  DELETE FROM tiktok_sessions 
  WHERE (status = 'disconnected' OR status = 'pending' OR status = 'error')
    AND created_at < NOW() - INTERVAL '30 seconds';
END;
$$ LANGUAGE plpgsql;
`);

console.log("✅ Railway pronto para batalhas VS e roleta de gifts!");
