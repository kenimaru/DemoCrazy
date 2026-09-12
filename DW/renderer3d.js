/* Dependency-free WebGL battlefield renderer. World coordinates: x, elevation, z. */
class Battlefield3D {
  constructor(canvas) {
    this.canvas=canvas;
    const gl=this.gl=canvas.getContext('webgl',{antialias:true,alpha:false});
    if(!gl) throw Error('WebGL is unavailable. Enable hardware acceleration or use another browser.');
    const shader=(type,src)=>{const s=gl.createShader(type);gl.shaderSource(s,src);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(s));return s};
    const program=this.program=gl.createProgram();
    gl.attachShader(program,shader(gl.VERTEX_SHADER,`attribute vec3 position; attribute vec3 color;
      uniform vec3 eye; uniform vec3 right; uniform vec3 up; uniform vec3 forward; uniform float aspect;
      varying vec3 tint; varying float depth;
      void main(){vec3 p=position-eye;float z=dot(p,forward);depth=z;tint=color;
      gl_Position=vec4(dot(p,right)*1.65/aspect,dot(p,up)*1.65,1.001*z-2.001,z);}`));
    gl.attachShader(program,shader(gl.FRAGMENT_SHADER,`precision mediump float;varying vec3 tint;varying float depth;
      void main(){float fog=smoothstep(600.0,2200.0,depth);gl_FragColor=vec4(mix(tint,vec3(.37,.45,.44),fog),1.0);}`));
    gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(program));
    gl.useProgram(program);this.buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,this.buffer);
    for(const [name,offset] of [['position',0],['color',12]]){let a=gl.getAttribLocation(program,name);gl.enableVertexAttribArray(a);gl.vertexAttribPointer(a,3,gl.FLOAT,false,24,offset)}
    this.uniforms=Object.fromEntries(['eye','right','up','forward','aspect'].map(n=>[n,gl.getUniformLocation(program,n)]));
    gl.enable(gl.DEPTH_TEST);this.data=new Float32Array(1500000);this.count=0;this.palette=new Map();
  }
  color(hex){if(!this.palette.has(hex)){let n=parseInt(hex.slice(1),16);this.palette.set(hex,[(n>>16)/255,((n>>8)&255)/255,(n&255)/255])}return this.palette.get(hex)}
  tri(a,b,c,color,light=1){const rgb=this.color(color);for(const p of [a,b,c]){this.data[this.count++]=p[0];this.data[this.count++]=p[1];this.data[this.count++]=p[2];for(let i=0;i<3;i++)this.data[this.count++]=rgb[i]*light}}
  quad(a,b,c,d,color,light=1){this.tri(a,b,c,color,light);this.tri(a,c,d,color,light)}
  box(x,y,z,w,h,d,color,angle=0){let co=Math.cos(angle),si=Math.sin(angle);const p=(a,b,c)=>[x+a*co-c*si,y+b,z+a*si+c*co];
    let v=[p(-w/2,0,-d/2),p(w/2,0,-d/2),p(w/2,0,d/2),p(-w/2,0,d/2),p(-w/2,h,-d/2),p(w/2,h,-d/2),p(w/2,h,d/2),p(-w/2,h,d/2)];
    this.quad(v[4],v[5],v[6],v[7],color,1.12);this.quad(v[0],v[1],v[5],v[4],color,.85);this.quad(v[1],v[2],v[6],v[5],color,.65);this.quad(v[2],v[3],v[7],v[6],color,.75);this.quad(v[3],v[0],v[4],v[7],color,.95);
  }
  ring(x,z,r,width,color,start=0,end=Math.PI*2,height=1){const n=Math.ceil((end-start)*14);for(let i=0;i<n;i++){let a=start+(end-start)*i/n,b=start+(end-start)*(i+1)/n;this.quad([x+Math.cos(a)*r,height,z+Math.sin(a)*r],[x+Math.cos(b)*r,height,z+Math.sin(b)*r],[x+Math.cos(b)*(r-width),height,z+Math.sin(b)*(r-width)],[x+Math.cos(a)*(r-width),height,z+Math.sin(a)*(r-width)],color)}}
  warrior(e,hero,time,attacking,moving){let s=hero?1.35:e.officer?1.5:1,a=e.angle+Math.PI/2,co=Math.cos(a),si=Math.sin(a),lift=e.stun>0&&!e.officer?Math.sin(Math.min(1,e.stun/.6)*Math.PI)*24:0;
    const part=(x,y,z,w,h,d,c,extra=0)=>this.box(e.x+(x*co-z*si)*s,(y+lift)*s,e.y+(x*si+z*co)*s,w*s,h*s,d*s,c,a+extra);
    let armor=e.flash>0?'#fff0b5':hero?'#d5bb7e':e.officer?'#ad633f':'#727f7c',cloth=hero?'#a32f36':e.officer?'#732c2f':'#303f43';
    let stride=moving?Math.sin(time*13+(e.phase||0))*5:0;
    part(-5,2, stride,7,17,9,'#303638');part(5,2,-stride,7,17,9,'#303638');
    part(0,18,0,21,21,13,armor);part(0,17,8,22,27,3,cloth);part(-13,28,0,9,12,12,armor);part(13,28,0,9,12,12,armor);
    part(0,40,0,12,12,12,'#c7a888');part(0,49,0,16,6,15,armor);part(0,54,1,3,10,12,cloth);
    let swing=hero&&attacking?Math.sin(attacking*17)*1.8:0;
    part(16,17,-20,3,3,75,'#a78d62',swing);part(16+Math.sin(swing)*37,17,-20-Math.cos(swing)*37,7,4,17,'#e4e6ce',swing);
    if(hero)this.ring(e.x,e.y,23,2,'#eac679');
    if(e.officer){this.box(e.x,85,e.y,45,4,3,'#3c2f28');this.box(e.x-(45-45*e.hp/e.max)/2,85.5,e.y-1,45*e.hp/e.max,4,3,'#ed9a5b')}
  }
  render({W,H,dpr,cam,yaw,distance,player,enemies,bases,swings,particles,clock,attackTimer,shake,moving}){
    const gl=this.gl;if(this.canvas.width!==Math.round(W*dpr)||this.canvas.height!==Math.round(H*dpr)){this.canvas.width=Math.round(W*dpr);this.canvas.height=Math.round(H*dpr)}gl.viewport(0,0,this.canvas.width,this.canvas.height);
    gl.clearColor(.37,.45,.44,1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);this.count=0;
    const sin=Math.sin(yaw),cos=Math.cos(yaw),pitch=.43,cp=Math.cos(pitch),sp=Math.sin(pitch);
    let eye=[cam.x+sin*distance,60+distance*Math.tan(pitch),cam.y+cos*distance];
    gl.uniform3fv(this.uniforms.eye,eye);gl.uniform3fv(this.uniforms.right,[cos,0,-sin]);gl.uniform3fv(this.uniforms.up,[-sin*sp,cp,-cos*sp]);gl.uniform3fv(this.uniforms.forward,[-sin*cp,-sp,-cos*cp]);gl.uniform1f(this.uniforms.aspect,W/H);
    for(let x=-1000;x<3400;x+=160)for(let z=-1000;z<2900;z+=160){let n=Math.sin(x*12.1+z*3.7);this.quad([x,-1,z],[x+160,-1,z],[x+160,-1,z+160],[x,-1,z+160],n>.3?'#485543':n<-.3?'#424e40':'#455141')}
    this.box(1200,-.6,1200,190,.5,1400,'#706d56');this.box(1200,-.4,850,1220,.5,145,'#706d56');
    // Perimeter walls and distant low-poly mountains establish depth and scale.
    for(let x=0;x<2400;x+=160){this.box(x,0,40,156,75,35,'#68716a');this.box(x,75,40,35,18,39,'#737b70')}
    for(let z=80;z<1800;z+=160){this.box(0,0,z,35,70,156,'#68716a');this.box(2400,0,z,35,70,156,'#68716a')}
    for(let i=0;i<25;i++){let x=-1200+i*200,z=-350-(i%4)*160,h=230+Math.sin(i*5)*130;this.tri([x-270,0,z],[x,h,z-100],[x+270,0,z],'#59685f',.8);this.tri([x,h,z-100],[x+400,0,z-230],[x+270,0,z],'#59685f',.65)}
    for(const b of bases){let color=b.progress>=100?'#72c7a0':'#be5941';this.ring(b.x,b.y,125,3,color);if(b.progress>0)this.ring(b.x,b.y,120,7,'#8ce0b0',-Math.PI/2,-Math.PI/2+Math.PI*2*b.progress/100,2);
      for(const side of [-1,1]){this.box(b.x+side*155,0,b.y-130,68,95,68,'#737a6b');this.box(b.x+side*155,95,b.y-130,84,12,84,'#3d4a43');for(let k=-1;k<=1;k++)this.box(b.x+side*155+k*25,105,b.y-130,13,15,80,'#697466')}
      this.box(b.x,0,b.y,5,150,5,'#b7a17a');this.quad([b.x,145,b.y],[b.x+58,137,b.y+Math.sin(clock*3)*9],[b.x+52,93,b.y+Math.sin(clock*3+1)*9],[b.x,101,b.y],color);
    }
    for(const e of enemies){if(e.hp<=0)continue;if(e.wind>0)this.ring(e.x,e.y,e.officer?115:40,e.officer?5:2,'#ee8451');this.warrior(e,false,clock,0,e.stun<=0&&Math.hypot(e.x-player.x,e.y-player.y)<650)}
    this.warrior(player,true,clock,attackTimer,moving);
    for(const s of swings){let t=s.life/s.max;this.ring(s.x,s.y,s.radius*(1-.2*t),s.fury?18:9,s.fury?'#fff0a4':s.heavy?'#f9ab53':'#f5dd9a',s.angle-s.arc,s.angle+s.arc,25+(1-t)*20);if(s.fury)this.ring(s.x,s.y,s.radius*(1-t),7,'#eabc66',0,Math.PI*2,5)}
    for(const p of particles)this.box(p.x,10+p.life*45,p.y,3,5,3,p.color);
    if(this.count>this.data.length)throw Error('Geometry budget exceeded');
    gl.bindBuffer(gl.ARRAY_BUFFER,this.buffer);gl.bufferData(gl.ARRAY_BUFFER,this.data.subarray(0,this.count),gl.DYNAMIC_DRAW);gl.drawArrays(gl.TRIANGLES,0,this.count/6);
  }
}
