const fs = require('fs');
let html = fs.readFileSync('e:/Projects/Websites/cebian/design/cebian-sidebar.html', 'utf8');

const settingsBlock = \        <!-- Settings Slide-in Overlay -->
        <div class="settings-overlay" id="settings-panel" style="padding-bottom: 20px;">
            <div class="settings-header">
                设置 (Settings)
                <button class="icon-btn" id="settings-close"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></button>
            </div>
            <div class="settings-body" style="gap:24px; padding-top: 10px;">
                <div class="form-group">
                    <label style="color: var(--text-tertiary); font-size: 0.75rem; letter-spacing: 0.5px;">LLM 模型配置</label>
                    <div style="color:var(--text-primary); font-size:0.9rem; margin-bottom:4px;">切换模型提供商</div>
                    <select style="background:var(--bg-panel);">
                        <option>GitHub Copilot Device Flow</option>
                        <option>OpenAI API</option>
                        <option>Anthropic Claude</option>
                        <option>Local Ollama</option>
                    </select>
                </div>
                
                <hr style="border:none; border-top:1px solid var(--border); margin:0;">
                
                <div class="form-group">
                    <label style="color: var(--text-tertiary); font-size: 0.75rem; letter-spacing: 0.5px; margin-bottom: 12px;">功能设置</label>
                    
                    <div class="switch-container">
                        <div class="switch-text">
                            <span class="switch-title">代码执行前确认</span>
                            <span class="switch-desc">执行脚本前弹窗确认</span>
                        </div>
                        <div>
                            <input type="checkbox" id="sw-confirm" class="switch-input" checked>
                            <label for="sw-confirm" class="switch-label"></label>
                        </div>
                    </div>
                    
                    <div class="switch-container" style="margin-top: 12px;">
                        <div class="switch-text">
                            <span class="switch-title">流式输出</span>
                            <span class="switch-desc">实时显示 AI 回复</span>
                        </div>
                        <div>
                            <input type="checkbox" id="sw-stream" class="switch-input" checked>
                            <label for="sw-stream" class="switch-label"></label>
                        </div>
                    </div>
                    
                    <div class="switch-container" style="margin-top: 12px;">
                        <div class="switch-text">
                            <span class="switch-title">后台任务持久化</span>
                            <span class="switch-desc">使用 Offscreen Document 保持定时任务</span>
                        </div>
                        <div>
                            <input type="checkbox" id="sw-background" class="switch-input" checked>
                            <label for="sw-background" class="switch-label"></label>
                        </div>
                    </div>

                    <div class="switch-container" style="margin-top: 12px;">
                        <div class="switch-text">
                            <span class="switch-title">深色模式</span>
                            <span class="switch-desc">主题颜色自动切换</span>
                        </div>
                        <div>
                            <input type="checkbox" id="sw-dark-setting" class="switch-input" checked>
                            <label for="sw-dark-setting" class="switch-label"></label>
                        </div>
                    </div>
                </div>

                <div style="flex:1;"></div>
                <button class="btn-sm primary" style="padding:12px; font-size:0.9rem; font-weight: 600; width: 100%;">保存并返回</button>
            </div>
        </div>\;

html = html.replace(/<!-- Settings Slide-up Overlay -->[\\s\\S]*?Save & Apply<\\/button>\\s*<\\/div>\\s*<\\/div>/, settingsBlock);
fs.writeFileSync('e:/Projects/Websites/cebian/design/cebian-sidebar.html', html, 'utf8');
