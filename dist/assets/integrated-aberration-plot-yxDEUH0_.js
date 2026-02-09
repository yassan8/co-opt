function P(o){return o<.45?"#8B00FF":o<.495?"#0000FF":o<.57?"#00FF00":o<.59?"#9ACD32":o<.62?"#FF8800":"#FF0000"}function $(o){const l=Array.isArray(o)?o:[],s=e=>(e?.position??e?.fieldType??e?.field_type??e?.field??e?.type??"").toString().toLowerCase(),n=l.map(s).filter(Boolean),u=n.some(e=>e.includes("rect")||e.includes("rectangle")),y=n.some(e=>e.includes("height"));return u||y?{mode:"height"}:n.some(e=>e.includes("angle"))?{mode:"angle"}:{mode:l.some(e=>{const r=parseFloat(e?.yHeight??e?.y??e?.height??e?.y_height??NaN);return Number.isFinite(r)&&Math.abs(r)>0})?"height":"angle"}}function j(o,l,s,n={}){console.log("📊 統合収差図作成開始");const u=n?.containerElement||null,y=n?.infoElement||null;if(u){const F=u.ownerDocument?.defaultView||window,E=F?.Plotly||(typeof Plotly<"u"?Plotly:null);if(!E){console.error("❌ Plotly library is not loaded"),alert("Plotly.js がロードされていません。");return}const i={...{width:1440,height:600,mainTitle:"Integrated Aberration Diagram",configName:"",...n},...n};k({targetWindow:F,plotly:E,containerElement:u,infoElement:y},o,l,s,i);return}if(typeof Plotly>"u"){console.error("❌ Plotly library is not loaded"),alert("Plotly.js がロードされていません。HTMLファイルにPlotly.jsを含めてください。");return}const t=window.open("","_blank","width=1600,height=1024");if(!t){alert("ポップアップブロックが有効になっている可能性があります。");return}const e={...{width:1440,height:600,mainTitle:"Integrated Aberration Diagram",configName:"",...n},...n};t.document.write(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <title>Integrated Aberration Diagram</title>
            <script src="https://cdn.plot.ly/plotly-2.26.0.min.js"><\/script>
            <style>
                body {
                    font-family: Arial, sans-serif;
                    margin: 20px;
                    background-color: #f5f5f5;
                }
                h1 {
                    text-align: center;
                    color: #333;
                    margin-bottom: 20px;
                }
                #plot-container {
                    background-color: white;
                    padding: 20px;
                    border-radius: 8px;
                    box-shadow: 0 2px 4px rgba(0,0,0,0.1);
                }
                .info-panel {
                    margin-top: 20px;
                    padding: 15px;
                    background-color: #f9f9f9;
                    border-left: 4px solid #4CAF50;
                    border-radius: 4px;
                }
                .info-panel h3 {
                    margin-top: 0;
                    color: #4CAF50;
                }
            </style>
        </head>
        <body>
            <h1>${e.mainTitle}</h1>
            <div id="plot-container"></div>
            <div class="info-panel" id="info-panel"></div>
        </body>
        </html>
    `),t.document.close();const r=setInterval(()=>{t.Plotly&&(clearInterval(r),k({targetWindow:t,plotly:t.Plotly,containerElement:t.document.getElementById("plot-container"),infoElement:t.document.getElementById("info-panel")},o,l,s,e))},100)}function k(o,l,s,n,u){const y=o?.targetWindow||window,t=o?.plotly||y?.Plotly,f=o?.containerElement||y?.document?.getElementById?.("plot-container"),e=o?.infoElement||null;if(!t){console.error("❌ Plotly library is not loaded (createIntegratedPlot)");return}if(!f){console.error("❌ Plot container is missing (createIntegratedPlot)");return}const r=[];let b=[];try{b=(y.opener||window)?.tableObject?.getData?.()||[]}catch{b=[]}const E=$(b).mode==="height";if(l&&l.meridionalData&&(l.meridionalData.forEach((i,w)=>{const d=i.wavelength,a=(d*1e3).toFixed(1),h=P(d),m=[...i.points].sort((g,z)=>g.pupilCoordinate-z.pupilCoordinate),c=m.map(g=>g.longitudinalAberration),p=m.map(g=>g.pupilCoordinate);r.push({x:c,y:p,mode:"lines+markers",type:"scatter",name:`SA ${a}nm`,line:{color:h,width:2},marker:{size:4,color:h},xaxis:"x",yaxis:"y",legendgroup:`spherical-${a}`,showlegend:!0})}),l.sagittalData&&l.sagittalData.forEach((i,w)=>{const d=i.wavelength,a=(d*1e3).toFixed(1),h=P(d),m=[...i.points].sort((g,z)=>g.pupilCoordinate-z.pupilCoordinate),c=m.map(g=>g.longitudinalAberration),p=m.map(g=>g.pupilCoordinate);r.push({x:c,y:p,mode:"lines+markers",type:"scatter",name:`${a}nm (S)`,line:{color:h,width:2,dash:"dash"},marker:{size:4,color:h,symbol:"square"},xaxis:"x",yaxis:"y",legendgroup:`spherical-${a}`,showlegend:!1})})),s&&s.data&&s.data.length>0){const i={};s.data.forEach(w=>{const d=w.wavelength;i[d]||(i[d]=[]),i[d].push(w)}),Object.entries(i).forEach(([w,d])=>{const a=parseFloat(w),h=(a*1e3).toFixed(1),m=P(a),c=d.sort((x,I)=>x.fieldAngle-I.fieldAngle),p=c.map(x=>x.meridionalDeviation||0),g=c.map(x=>x.fieldAngle);p.length>0&&r.push({x:p,y:g,mode:"lines+markers",type:"scatter",name:`AS ${h}nm M:solid, S:dashed`,line:{color:m,width:2},marker:{size:4,color:m},xaxis:"x2",yaxis:"y2",legendgroup:`astigmatism-${h}`,showlegend:!0});const z=c.map(x=>x.sagittalDeviation||0),v=c.map(x=>x.fieldAngle);z.length>0&&r.push({x:z,y:v,mode:"lines+markers",type:"scatter",name:`${h}nm (S)`,line:{color:m,width:2,dash:"dash"},marker:{size:4,color:m,symbol:"square"},xaxis:"x2",yaxis:"y2",legendgroup:`astigmatism-${h}`,showlegend:!1})})}n&&Array.isArray(n)&&n.forEach((i,w)=>{const{wavelength:d,data:a}=i;if(a&&a.fieldValues&&a.distortionPercent){const h=a.distortionPercent.filter(c=>c!==null),m=a.fieldValues.filter((c,p)=>a.distortionPercent[p]!==null);if(h.length>0){const c=(d*1e3).toFixed(1),p=P(d);r.push({x:h,y:m,mode:"lines+markers",type:"scatter",name:`DIST ${c}nm`,line:{color:p,width:2},marker:{size:6,color:p},xaxis:"x3",yaxis:"y3",legendgroup:`distortion-${c}`,showlegend:!0})}}});const A={title:{text:"",font:{size:18,family:"Arial, sans-serif"}},width:u.width,height:u.height,xaxis:{title:{text:"Longitudinal Aberration (mm)",font:{size:12}},domain:[0,.28],range:[-.5,.5],dtick:.1,ticklabelstandoff:10,zeroline:!0,zerolinecolor:"#000000",zerolinewidth:2,gridcolor:"#E0E0E0"},yaxis:{title:{text:"Normalized Pupil Coord.",font:{size:12}},anchor:"x",domain:[0,1],range:[0,1],rangemode:"tozero",gridcolor:"#E0E0E0",zeroline:!0,zerolinecolor:"#000000",zerolinewidth:2},xaxis2:{title:{text:"Image Position (mm)",font:{size:12}},domain:[.36,.64],anchor:"y2",range:[-.5,.5],dtick:.1,ticklabelstandoff:10,zeroline:!0,zerolinecolor:"#000000",zerolinewidth:1,gridcolor:"#E0E0E0"},yaxis2:{title:{text:E?"Object Height (mm)":"Object Angle θ (deg)",font:{size:12}},anchor:"x2",domain:[0,1],rangemode:"tozero",autorange:!0,gridcolor:"#E0E0E0",zeroline:!0,zerolinecolor:"#000000",zerolinewidth:1},xaxis3:{title:{text:"Distortion (%)",font:{size:12}},domain:[.72,1],anchor:"y3",range:[-5,5],dtick:1,ticklabelstandoff:10,zeroline:!0,zerolinecolor:"#000000",zerolinewidth:2,gridcolor:"#E0E0E0"},yaxis3:{title:{text:E?"Object Height (mm)":"Object Angle θ (deg)",font:{size:12}},anchor:"x3",domain:[0,1],rangemode:"tozero",autorange:!0,gridcolor:"#E0E0E0",zeroline:!0,zerolinecolor:"#000000",zerolinewidth:1},showlegend:!0,legend:{x:1.02,y:1,xanchor:"left",yanchor:"top",bgcolor:"rgba(255, 255, 255, 0.8)",bordercolor:"#cccccc",borderwidth:1},annotations:[{text:"Spherical Aberration",x:.14,y:1.05,xref:"paper",yref:"paper",xanchor:"center",yanchor:"bottom",showarrow:!1,font:{size:14,color:"#333",weight:"bold"}},{text:"Astigmatic Field Curves",x:.5,y:1.05,xref:"paper",yref:"paper",xanchor:"center",yanchor:"bottom",showarrow:!1,font:{size:14,color:"#333",weight:"bold"}},{text:"Distortion",x:.86,y:1.05,xref:"paper",yref:"paper",xanchor:"center",yanchor:"bottom",showarrow:!1,font:{size:14,color:"#333",weight:"bold"}}],margin:{l:60,r:150,t:100,b:60},hovermode:"closest",autosize:!1};o?.containerElement&&(A.autosize=!0,delete A.width,delete A.height),t.newPlot(f,r,A,{responsive:!0,displayModeBar:!0,modeBarButtonsToRemove:["pan2d","lasso2d"],displaylogo:!1}),e&&C({infoElement:e},l,s,n,E),console.log("✅ 統合収差図作成完了")}function C(o,l,s,n,u=!1){const y=o?.infoElement||null;if(!y)return;let t="<h3>Aberration Diagram Information</h3>";if(t+="<ul>",l){const f=l.meridionalData?.map(e=>`${(e.wavelength*1e3).toFixed(1)}nm`).join(", ")||"N/A";t+=`<li><strong>Spherical Aberration:</strong> Wavelengths ${f}</li>`}if(s&&s.data){const e=new Set(s.data.map(b=>b.fieldAngle)).size;t+=`<li><strong>Astigmatism:</strong> ${e} ${u?"object heights":"object angles"}</li>`}if(n&&Array.isArray(n)){let f=0;n.forEach(e=>{e.data&&e.data.distortionPercent&&e.data.distortionPercent.forEach(r=>{r!==null&&(f=Math.max(f,Math.abs(r)))})}),t+=`<li><strong>Distortion:</strong> Maximum ${f.toFixed(2)}%</li>`}t+="</ul>",t+="<p><em>Legend: M=Meridional, S=Sagittal</em></p>",y.innerHTML=t}export{j as plotIntegratedAberrationDiagram};
