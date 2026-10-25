// Original vector character portraits. Kept as SVG so small table portraits stay crisp.
const palettes = [
  {bg:'#d8d5ce',light:'#fff8e9',hair:'#443634',shine:'#82706a',coat:'#b3c2cb',dark:'#657b8b',eye:'#846348',female:true,bun:true},
  {bg:'#a2bcd5',light:'#e6f5fc',hair:'#202b3d',shine:'#5d6a7f',coat:'#e7eef4',dark:'#8babc5',eye:'#58748e',female:false},
  {bg:'#b2a8c3',light:'#f2e6ec',hair:'#282530',shine:'#655f72',coat:'#303a4c',dark:'#151e2e',eye:'#746784',female:false},
  {bg:'#b4c7ba',light:'#f6f2df',hair:'#613d32',shine:'#a67a60',coat:'#ede0c7',dark:'#a39576',eye:'#64765d',female:true,bun:false},
];
export function avatarArtwork(index) {
 const p=palettes[index%4], f=p.female;
 const strands = [
  'M71 104C55 67 83 33 121 29', 'M69 84C74 48 102 32 138 32',
  'M80 72C103 39 137 34 166 48', 'M104 49C137 33 180 49 189 77',
  'M119 43C118 66 138 88 161 97', 'M135 42C130 67 153 83 175 91',
  'M147 46C149 64 169 72 185 75', 'M160 53C176 56 188 70 191 88',
  'M107 47C105 80 89 94 80 109', 'M96 54C93 87 78 101 80 126',
  'M87 66C78 82 73 104 76 125', 'M170 66C183 74 189 91 183 108',
 ];
 return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 256 256" role="img" aria-label="原创插画玩家头像">
 <defs>
 <linearGradient id="bg" x2=".8" y2="1"><stop stop-color="${p.bg}"/><stop offset="1" stop-color="${p.light}"/></linearGradient>
 <radialGradient id="halo"><stop stop-color="#fff" stop-opacity=".55"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
 <linearGradient id="skin" x1="0" x2="1" y2=".6"><stop stop-color="#e4ad96"/><stop offset=".46" stop-color="#f6cfb7"/><stop offset="1" stop-color="#fff0d9"/></linearGradient>
 <linearGradient id="neck" x2=".8" y2="1"><stop stop-color="#bd897b"/><stop offset=".65" stop-color="#efbca2"/><stop offset="1" stop-color="#f9d5bb"/></linearGradient>
 <linearGradient id="hair" x2=".8" y2="1"><stop stop-color="${p.shine}"/><stop offset=".3" stop-color="${p.hair}"/><stop offset=".8" stop-color="${p.hair}"/><stop offset="1" stop-color="${p.shine}"/></linearGradient>
 <linearGradient id="coat" x2="1" y2=".6"><stop stop-color="${p.coat}"/><stop offset=".65" stop-color="${p.coat}"/><stop offset="1" stop-color="${p.dark}"/></linearGradient>
 <linearGradient id="iris" x2="0" y2="1"><stop stop-color="#242735"/><stop offset="1" stop-color="${p.eye}"/></linearGradient>
 <radialGradient id="blush"><stop stop-color="#d9857e" stop-opacity=".38"/><stop offset="1" stop-color="#d9857e" stop-opacity="0"/></radialGradient>
 </defs>
 <path fill="url(#bg)" d="M0 0h256v256H0z"/>
 <circle cx="179" cy="95" r="131" fill="url(#halo)"/>
 <g fill="none" stroke="#fff" opacity=".17"><circle cx="203" cy="56" r="82"/><circle cx="203" cy="56" r="95"/><path d="M14 207L238 22M-4 191L220 6"/></g>
 ${p.bun?`<path d="M78 119C30 108 31 63 50 47C44 27 75 17 89 40C106 53 101 94 78 119Z" fill="url(#hair)"/><g stroke="${p.shine}" stroke-width="1.7" fill="none" opacity=".7"><path d="M54 98C35 79 48 48 71 48C96 53 86 94 64 93C43 91 47 61 67 57C84 54 85 82 66 85"/><path d="M52 55C45 34 69 26 78 42M51 96C66 110 80 101 87 90"/></g>`:''}
 ${f&&!p.bun?`<path d="M65 103C55 134 48 181 54 218L88 227L113 197L177 224L208 201C190 168 191 121 185 92Z" fill="url(#hair)"/><path d="M69 121Q62 178 76 210M178 109Q169 172 190 207" fill="none" stroke="${p.shine}" stroke-width="3" opacity=".5"/>`:''}
 <path d="M22 256Q26 225 65 210L102 194L162 194Q211 210 239 256Z" fill="${p.dark}"/>
 <path d="M112 155L106 192L91 204Q117 233 164 207L151 184L155 154Z" fill="url(#neck)"/>
 <path d="M112 169Q130 191 153 172L150 155Z" fill="#976a64" opacity=".22"/>
 <path d="M83 211L106 191Q105 211 130 219L158 191L188 211L223 228L240 256H17Q28 226 83 211Z" fill="url(#coat)"/>
 ${f?`<path d="M105 191L82 200L70 216L111 243L127 220Q105 209 105 191Z" fill="#eaf0f0"/><path d="M157 190L178 201L184 222L144 241L129 221Z" fill="#f6f3e9"/><path d="M82 202L88 217L116 237M170 203L167 219L141 236M128 224L124 256" stroke="${p.dark}" opacity=".5" fill="none" stroke-width="2"/>`:`<path d="M107 192L86 201L114 238L131 218Z" fill="${index===2?'#4e5a70':'#f8fcff'}"/><path d="M156 190L177 202L153 235L131 218Z" fill="${index===2?'#485366':'#f8fcff'}"/><path d="M131 220L138 256M91 210L71 240M175 211L195 245" stroke="${p.dark}" fill="none" stroke-width="2"/>`}
 <path d="M45 239Q68 228 92 234M182 237Q204 243 211 256" stroke="#fff" stroke-opacity=".3" stroke-width="2" fill="none"/>
 <path d="M80 96C77 71 92 51 120 46C157 40 182 59 184 90L181 118L193 136Q194 140 183 142L179 158Q165 178 147 183Q126 182 103 160L91 130Z" fill="url(#skin)" stroke="#bc8b7d" stroke-width="1.1"/>
 <path d="M87 101C77 99 76 113 82 124Q87 139 98 139L101 125Z" fill="#e8b49e" stroke="#c38b79" stroke-width="1.4"/>
 <path d="M86 111Q80 108 87 125M88 116Q94 114 95 127" stroke="#bd877a" fill="none" stroke-width="1.5"/>
 <path d="M102 99Q99 131 107 150Q122 174 143 181Q124 176 103 160L96 137Z" fill="#b47871" opacity=".15"/>
 <ellipse cx="139" cy="142" rx="22" ry="12" fill="url(#blush)"/><ellipse cx="176" cy="136" rx="12" ry="9" fill="url(#blush)"/>
 <path d="M163 115L162 133L157 139Q162 142 169 139" fill="none" stroke="#bf8d7b" stroke-width="1.3" stroke-linecap="round"/>
 <path d="M170 131L180 135" stroke="#fff5e8" stroke-width="2" stroke-linecap="round" opacity=".7"/>
 <path d="M115 113Q127 106 144 115Q132 126 117 119Z" fill="#fff9ec"/>
 <path d="M166 112Q175 108 182 113L178 119Q169 122 166 112Z" fill="#fff9ec"/>
 <ellipse cx="132" cy="116" rx="5.4" ry="7" fill="url(#iris)"/><ellipse cx="176" cy="114.7" rx="3.6" ry="5.6" fill="url(#iris)"/>
 <ellipse cx="132" cy="116" rx="2.2" ry="4.8" fill="#252331"/><ellipse cx="176" cy="114.7" rx="1.5" ry="3.6" fill="#252331"/>
 <circle cx="130.4" cy="112.8" r="1.9" fill="#fff"/><circle cx="174.8" cy="112.3" r="1.3" fill="#fff"/>
 <path d="M112 112Q126 105 144 114M165 111Q174 107 184 112" stroke="${p.hair}" fill="none" stroke-width="${f?2.5:2}" stroke-linecap="round"/>
 <path d="M118 123Q129 127 140 122M169 122L179 121" stroke="#c59384" fill="none" stroke-width="1"/>
 <path d="M112 100Q129 95 143 102M165 101Q176 97 183 100" fill="none" stroke="${p.hair}" stroke-width="${f?2.2:3}" stroke-linecap="round"/>
 <path d="M148 155Q158 151 171 153Q160 159 151 159Z" fill="#cd8c87" opacity=".7"/>
 <path d="M148 154Q158 155 170 153" fill="none" stroke="#9c635e" stroke-width="1.2" stroke-linecap="round"/>
 <path d="M152 162Q161 164 167 160" fill="none" stroke="#fff2e0" stroke-width="1.8" stroke-linecap="round"/>
 <path d="M77 126C58 114 53 85 63 63C72 37 101 29 120 30C148 17 175 38 185 50C198 68 199 84 187 105L179 101L180 85C164 93 142 78 130 63C130 89 109 103 102 126L97 142L91 126L89 109L84 108L83 129Z" fill="url(#hair)" stroke="${p.hair}" stroke-width="1.5"/>
 <path d="M71 72Q59 77 55 88Q57 53 85 42L77 39Q101 23 124 29L137 23Q172 28 185 49Q170 39 157 40Q181 49 189 67L196 67L193 82Q178 79 168 68Q177 86 185 89Q158 88 139 66Q142 85 150 94Q120 82 122 55Q108 82 96 94Q95 113 85 126Q87 104 81 93Z" fill="${p.hair}"/>
 <g fill="none" stroke="${p.shine}" stroke-linecap="round" opacity=".58">${strands.map((d,j)=>`<path d="${d}" stroke-width="${j%3===0?1.7:.9}"/>`).join('')}</g>
 <path d="M86 48Q105 35 122 36M145 38Q171 41 183 59M67 74Q68 59 80 50" fill="none" stroke="#e5dfe0" stroke-opacity=".23" stroke-width="2" stroke-linecap="round"/>
 ${f?`<circle cx="96" cy="139" r="2.7" fill="#f5e5bd"/><path d="M96 142L97 150" stroke="#a88857"/><circle cx="97" cy="152" r="3" fill="#faf0d6" stroke="#bda77c"/>`:''}
 ${p.bun?`<path d="M76 92Q70 112 80 140Q73 156 80 169" fill="none" stroke="${p.hair}" stroke-width="2"/><path d="M78 104Q62 135 75 146" fill="none" stroke="${p.shine}" stroke-width="1"/>`:''}
 ${index===1?`<g fill="none" stroke="#53697b" stroke-width="1.4"><path d="M107 109Q125 104 147 110L145 124Q123 131 110 121ZM164 109Q176 106 186 108L184 120Q173 126 165 120Z"/><path d="M147 113Q156 108 165 113M107 110L88 106"/></g><path d="M111 110L128 108M167 109L177 108" stroke="#fff" stroke-width="1.2" opacity=".7"/>`:''}
 <path d="M0 255.5H256" stroke="#fff" stroke-opacity=".2"/>
 </svg>`;
}
