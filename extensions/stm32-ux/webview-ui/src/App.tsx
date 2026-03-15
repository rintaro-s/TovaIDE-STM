import React, { useState, useEffect } from 'react';
import './App.css';

interface MessageEvent {
  data: {
    type: string;
    text?: string;
  };
}

export default function App() {
  const [iocData, setIocData] = useState<string>('');
  
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const message = event.data;
      if (message.type === 'update' && message.text) {
        setIocData(message.text);
      }
    };
    
    window.addEventListener('message', handleMessage as any);
    
    // Notify VS Code that we are ready
    // @ts-ignore
    if (typeof acquireVsCodeApi === 'function') {
      // @ts-ignore
      const vscode = acquireVsCodeApi();
      vscode.postMessage({ type: 'ready' });
    }
    
    return () => {
      window.removeEventListener('message', handleMessage as any);
    };
  }, []);

  // Parse very simple keys for now to show functionality
  const lines = iocData.split('\n');
  const mcuLine = lines.find(l => l.startsWith('Mcu.Name='));
  const mcuName = mcuLine ? mcuLine.split('=')[1] : 'Unknown MCU';

  return (
    <div className="app-container">
      <header className="header">
        <h1>TovaIDE-STM Board Configurator</h1>
        <div className="mcu-info">MCU: {mcuName}</div>
      </header>
      
      <div className="main-content">
        <aside className="sidebar">
          <nav>
            <ul>
              <li><button className="active">Pinout & Configuration</button></li>
              <li><button>Clock Configuration</button></li>
              <li><button>Project Manager</button></li>
              <li><button>Tools</button></li>
            </ul>
          </nav>
        </aside>
        
        <main className="editor-pane">
          <div className="mcu-view">
             {/* A placeholder for the MCU chip map SVG, which we will deeply implement later or right after */}
             <div className="chip-placeholder">
               <div className="chip-body">
                 {mcuName}
                 <div className="chip-details">LQFP144 / QFN / BGA...</div>
               </div>
             </div>
          </div>
          
          <div className="config-pane">
            <h2>System Core</h2>
            <div className="config-items">
              <div className="config-item">
                 <label>SYS</label>
                 <span>[Debug: Serial Wire]</span>
              </div>
              <div className="config-item">
                 <label>RCC</label>
                 <span>[HSE: Crystal/Ceramic Resonator]</span>
              </div>
            </div>
            
            <h2>Raw .ioc File Content (Debug)</h2>
            <pre className="file-content">{iocData}</pre>
          </div>
        </main>
      </div>
    </div>
  );
}