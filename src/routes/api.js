const express = require('express');
const claudeRelayService = require('../services/claudeRelayService');
const claudeConsoleRelayService = require('../services/claudeConsoleRelayService');
const unifiedClaudeScheduler = require('../services/unifiedClaudeScheduler');
const apiKeyService = require('../services/apiKeyService');
const { authenticateApiKey } = require('../middleware/auth');
const logger = require('../utils/logger');
const redis = require('../models/redis');
const sessionHelper = require('../utils/sessionHelper');

const router = express.Router();

// 🔧 共享的消息处理函数
async function handleMessagesRequest(req, res) {
  try {
    const startTime = Date.now();
    
    // 严格的输入验证
    if (!req.body || typeof req.body !== 'object') {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'Request body must be a valid JSON object'
      });
    }

    if (!req.body.messages || !Array.isArray(req.body.messages)) {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'Missing or invalid field: messages (must be an array)'
      });
    }

    if (req.body.messages.length === 0) {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'Messages array cannot be empty'
      });
    }

    // 检查是否为流式请求
    const isStream = req.body.stream === true;
    
    logger.api(`🚀 Processing ${isStream ? 'stream' : 'non-stream'} request for key: ${req.apiKey.name}`);

    if (isStream) {
      // 流式响应 - 只使用官方真实usage数据
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('X-Accel-Buffering', 'no'); // 禁用 Nginx 缓冲
      
      // 禁用 Nagle 算法，确保数据立即发送
      if (res.socket && typeof res.socket.setNoDelay === 'function') {
        res.socket.setNoDelay(true);
      }
      
      // 流式响应不需要额外处理，中间件已经设置了监听器
      
      let usageDataCaptured = false;
      
      // 生成会话哈希用于sticky会话
      const sessionHash = sessionHelper.generateSessionHash(req.body);
      
      // 使用统一调度选择账号（传递请求的模型）
      const requestedModel = req.body.model;
      const { accountId, accountType } = await unifiedClaudeScheduler.selectAccountForApiKey(req.apiKey, sessionHash, requestedModel);
      
      // 根据账号类型选择对应的转发服务并调用
      if (accountType === 'claude-official') {
        // 官方Claude账号使用原有的转发服务（会自己选择账号）
        await claudeRelayService.relayStreamRequestWithUsageCapture(req.body, req.apiKey, res, req.headers, (usageData) => {
        // 回调函数：当检测到完整usage数据时记录真实token使用量
        logger.info('🎯 Usage callback triggered with complete data:', JSON.stringify(usageData, null, 2));
        
        if (usageData && usageData.input_tokens !== undefined && usageData.output_tokens !== undefined) {
          const inputTokens = usageData.input_tokens || 0;
          const outputTokens = usageData.output_tokens || 0;
          const cacheCreateTokens = usageData.cache_creation_input_tokens || 0;
          const cacheReadTokens = usageData.cache_read_input_tokens || 0;
          const model = usageData.model || 'unknown';
          
          // 记录真实的token使用量（包含模型信息和所有4种token以及账户ID）
          const accountId = usageData.accountId;
          apiKeyService.recordUsage(req.apiKey.id, inputTokens, outputTokens, cacheCreateTokens, cacheReadTokens, model, accountId).catch(error => {
            logger.error('❌ Failed to record stream usage:', error);
          });
          
          // 更新时间窗口内的token计数
          if (req.rateLimitInfo) {
            const totalTokens = inputTokens + outputTokens + cacheCreateTokens + cacheReadTokens;
            redis.getClient().incrby(req.rateLimitInfo.tokenCountKey, totalTokens).catch(error => {
              logger.error('❌ Failed to update rate limit token count:', error);
            });
            logger.api(`📊 Updated rate limit token count: +${totalTokens} tokens`);
          }
          
          usageDataCaptured = true;
          logger.api(`📊 Stream usage recorded (real) - Model: ${model}, Input: ${inputTokens}, Output: ${outputTokens}, Cache Create: ${cacheCreateTokens}, Cache Read: ${cacheReadTokens}, Total: ${inputTokens + outputTokens + cacheCreateTokens + cacheReadTokens} tokens`);
        } else {
          logger.warn('⚠️ Usage callback triggered but data is incomplete:', JSON.stringify(usageData));
        }
        });
      } else {
        // Claude Console账号使用Console转发服务（需要传递accountId）
        await claudeConsoleRelayService.relayStreamRequestWithUsageCapture(req.body, req.apiKey, res, req.headers, (usageData) => {
          // 回调函数：当检测到完整usage数据时记录真实token使用量
          logger.info('🎯 Usage callback triggered with complete data:', JSON.stringify(usageData, null, 2));
          
          if (usageData && usageData.input_tokens !== undefined && usageData.output_tokens !== undefined) {
            const inputTokens = usageData.input_tokens || 0;
            const outputTokens = usageData.output_tokens || 0;
            const cacheCreateTokens = usageData.cache_creation_input_tokens || 0;
            const cacheReadTokens = usageData.cache_read_input_tokens || 0;
            const model = usageData.model || 'unknown';
            
            // 记录真实的token使用量（包含模型信息和所有4种token以及账户ID）
            const usageAccountId = usageData.accountId;
            apiKeyService.recordUsage(req.apiKey.id, inputTokens, outputTokens, cacheCreateTokens, cacheReadTokens, model, usageAccountId).catch(error => {
              logger.error('❌ Failed to record stream usage:', error);
            });
            
            // 更新时间窗口内的token计数
            if (req.rateLimitInfo) {
              const totalTokens = inputTokens + outputTokens + cacheCreateTokens + cacheReadTokens;
              redis.getClient().incrby(req.rateLimitInfo.tokenCountKey, totalTokens).catch(error => {
                logger.error('❌ Failed to update rate limit token count:', error);
              });
              logger.api(`📊 Updated rate limit token count: +${totalTokens} tokens`);
            }
            
            usageDataCaptured = true;
            logger.api(`📊 Stream usage recorded (real) - Model: ${model}, Input: ${inputTokens}, Output: ${outputTokens}, Cache Create: ${cacheCreateTokens}, Cache Read: ${cacheReadTokens}, Total: ${inputTokens + outputTokens + cacheCreateTokens + cacheReadTokens} tokens`);
          } else {
            logger.warn('⚠️ Usage callback triggered but data is incomplete:', JSON.stringify(usageData));
          }
        }, accountId);
      }
      
      // 流式请求完成后 - 如果没有捕获到usage数据，记录警告但不进行估算
      setTimeout(() => {
        if (!usageDataCaptured) {
          logger.warn('⚠️ No usage data captured from SSE stream - no statistics recorded (official data only)');
        }
      }, 1000); // 1秒后检查
    } else {
      // 非流式响应 - 只使用官方真实usage数据
      logger.info('📄 Starting non-streaming request', {
        apiKeyId: req.apiKey.id,
        apiKeyName: req.apiKey.name
      });
      
      // 生成会话哈希用于sticky会话
      const sessionHash = sessionHelper.generateSessionHash(req.body);
      
      // 使用统一调度选择账号（传递请求的模型）
      const requestedModel = req.body.model;
      const { accountId, accountType } = await unifiedClaudeScheduler.selectAccountForApiKey(req.apiKey, sessionHash, requestedModel);
      
      // 根据账号类型选择对应的转发服务
      let response;
      logger.debug(`[DEBUG] Request query params: ${JSON.stringify(req.query)}`);
      logger.debug(`[DEBUG] Request URL: ${req.url}`);
      logger.debug(`[DEBUG] Request path: ${req.path}`);
      
      if (accountType === 'claude-official') {
        // 官方Claude账号使用原有的转发服务
        response = await claudeRelayService.relayRequest(req.body, req.apiKey, req, res, req.headers);
      } else {
        // Claude Console账号使用Console转发服务
        logger.debug(`[DEBUG] Calling claudeConsoleRelayService.relayRequest with accountId: ${accountId}`);
        response = await claudeConsoleRelayService.relayRequest(req.body, req.apiKey, req, res, req.headers, accountId);
      }
      
      logger.info('📡 Claude API response received', {
        statusCode: response.statusCode,
        headers: JSON.stringify(response.headers),
        bodyLength: response.body ? response.body.length : 0
      });
      
      res.status(response.statusCode);
      
      // 设置响应头
      Object.keys(response.headers).forEach(key => {
        if (key.toLowerCase() !== 'content-encoding') {
          res.setHeader(key, response.headers[key]);
        }
      });
      
      let usageRecorded = false;
      
      // 尝试解析JSON响应并提取usage信息
      try {
        const jsonData = JSON.parse(response.body);
        
        logger.info('📊 Parsed Claude API response:', JSON.stringify(jsonData, null, 2));
        
        // 从Claude API响应中提取usage信息（完整的token分类体系）
        if (jsonData.usage && jsonData.usage.input_tokens !== undefined && jsonData.usage.output_tokens !== undefined) {
          const inputTokens = jsonData.usage.input_tokens || 0;
          const outputTokens = jsonData.usage.output_tokens || 0;
          const cacheCreateTokens = jsonData.usage.cache_creation_input_tokens || 0;
          const cacheReadTokens = jsonData.usage.cache_read_input_tokens || 0;
          const model = jsonData.model || req.body.model || 'unknown';
          
          // 记录真实的token使用量（包含模型信息和所有4种token以及账户ID）
          const accountId = response.accountId;
          await apiKeyService.recordUsage(req.apiKey.id, inputTokens, outputTokens, cacheCreateTokens, cacheReadTokens, model, accountId);
          
          // 更新时间窗口内的token计数
          if (req.rateLimitInfo) {
            const totalTokens = inputTokens + outputTokens + cacheCreateTokens + cacheReadTokens;
            await redis.getClient().incrby(req.rateLimitInfo.tokenCountKey, totalTokens);
            logger.api(`📊 Updated rate limit token count: +${totalTokens} tokens`);
          }
          
          usageRecorded = true;
          logger.api(`📊 Non-stream usage recorded (real) - Model: ${model}, Input: ${inputTokens}, Output: ${outputTokens}, Cache Create: ${cacheCreateTokens}, Cache Read: ${cacheReadTokens}, Total: ${inputTokens + outputTokens + cacheCreateTokens + cacheReadTokens} tokens`);
        } else {
          logger.warn('⚠️ No usage data found in Claude API JSON response');
        }
        
        res.json(jsonData);
      } catch (parseError) {
        logger.warn('⚠️ Failed to parse Claude API response as JSON:', parseError.message);
        logger.info('📄 Raw response body:', response.body);
        res.send(response.body);
      }
      
      // 如果没有记录usage，只记录警告，不进行估算
      if (!usageRecorded) {
        logger.warn('⚠️ No usage data recorded for non-stream request - no statistics recorded (official data only)');
      }
    }
    
    const duration = Date.now() - startTime;
    logger.api(`✅ Request completed in ${duration}ms for key: ${req.apiKey.name}`);
    
  } catch (error) {
    logger.error('❌ Claude relay error:', error.message, {
      code: error.code,
      stack: error.stack
    });
    
    // 确保在任何情况下都能返回有效的JSON响应
    if (!res.headersSent) {
      // 根据错误类型设置适当的状态码
      let statusCode = 500;
      let errorType = 'Relay service error';
      
      if (error.message.includes('Connection reset') || error.message.includes('socket hang up')) {
        statusCode = 502;
        errorType = 'Upstream connection error';
      } else if (error.message.includes('Connection refused')) {
        statusCode = 502;
        errorType = 'Upstream service unavailable';
      } else if (error.message.includes('timeout')) {
        statusCode = 504;
        errorType = 'Upstream timeout';
      } else if (error.message.includes('resolve') || error.message.includes('ENOTFOUND')) {
        statusCode = 502;
        errorType = 'Upstream hostname resolution failed';
      }
      
      res.status(statusCode).json({
        error: errorType,
        message: error.message || 'An unexpected error occurred',
        timestamp: new Date().toISOString()
      });
    } else {
      // 如果响应头已经发送，尝试结束响应
      if (!res.destroyed && !res.finished) {
        res.end();
      }
    }
  }
}

// 🚀 Claude API messages 端点 - /api/v1/messages
router.post('/v1/messages', authenticateApiKey, handleMessagesRequest);

// 🚀 Claude API messages 端点 - /claude/v1/messages (别名)
router.post('/claude/v1/messages', authenticateApiKey, handleMessagesRequest);

// 🏥 健康检查端点
router.get('/health', async (req, res) => {
  try {
    const healthStatus = await claudeRelayService.healthCheck();
    
    res.status(healthStatus.healthy ? 200 : 503).json({
      status: healthStatus.healthy ? 'healthy' : 'unhealthy',
      service: 'claude-relay-service',
      version: '1.0.0',
      ...healthStatus
    });
  } catch (error) {
    logger.error('❌ Health check error:', error);
    res.status(503).json({
      status: 'unhealthy',
      service: 'claude-relay-service',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// 📊 API Key状态检查端点 - /api/v1/key-info
router.get('/v1/key-info', authenticateApiKey, async (req, res) => {
  try {
    const usage = await apiKeyService.getUsageStats(req.apiKey.id);
    
    res.json({
      keyInfo: {
        id: req.apiKey.id,
        name: req.apiKey.name,
        tokenLimit: req.apiKey.tokenLimit,
        usage
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('❌ Key info error:', error);
    res.status(500).json({
      error: 'Failed to get key info',
      message: error.message
    });
  }
});

// 📈 使用统计端点 - /api/v1/usage
router.get('/v1/usage', authenticateApiKey, async (req, res) => {
  try {
    const usage = await apiKeyService.getUsageStats(req.apiKey.id);
    
    res.json({
      usage,
      limits: {
        tokens: req.apiKey.tokenLimit,
        requests: 0 // 请求限制已移除
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('❌ Usage stats error:', error);
    res.status(500).json({
      error: 'Failed to get usage stats',
      message: error.message
    });
  }
});

module.exports = router;