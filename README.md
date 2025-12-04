# SunDrowsy | Tactical Safety System

**Sistema Neural de Prevenção à Fadiga e Monitoramento de Vigilância**  
**Edge-Powered Computer Vision para Operações Críticas.**

Uma plataforma PWA de segurança operacional, construída com inferência local (Edge AI) para detecção de sonolência, distração e microssono em tempo real — sem stream de vídeo, sem latência, sem riscos de privacidade.

---

## 📋 Sobre o Projeto

O **SunDrowsy** é um sistema tático para ambientes que exigem foco contínuo: portarias, salas de monitoramento, CFTV, operações críticas, entre outros.

Ao contrário de soluções caras baseadas em hardware proprietário ou processamento em nuvem, o SunDrowsy executa **toda a IA no navegador**, garantindo:

- Zero latência nos alertas  
- Zero tráfego de imagem para a rede  
- Custos operacionais mínimos  
- Privacidade total (LGPD by design)

---

## 🚀 Principais Funcionalidades

### 🔹 Operador (Client Front-End)
- **Detecção Facial em Tempo Real**  
  468 landmarks via *MediaPipe FaceMesh*.

- **Análises de Fadiga Multivariáveis**
  - **EAR**: fechamento ocular / blink rate  
  - **MAR**: bocejos / abertura oral  
  - **Head Pose**: distração (cabeça baixa, olhar para cima, desvio lateral)  
  - **Microssonos**: lapsos críticos curtos

- **Alertas Sonoros Inteligentes**  
  Feedback auditivo imediato.

- **Modo Almoço**  
  Bloqueio temporário com registro.

---

### 🔹 Gestor (Painel Admin)
- **Dashboard em Tempo Real**  
  Streams Firestore com incidentes live.

- **Analytics Estruturado**  
  Distribuição por hora, intensidade, tipo de ocorrência.

- **Heatmaps**  
  Mapa de calor com concentração de eventos.

- **Gestão de Equipe**
  - Convites seguros (tokens únicos)
  - Admin/Owner/Vigia (RBAC)

- **Auditoria & Compliance**
  - Logs imutáveis  
  - Exportação CSV  
  - Trilhas de auditoria completas

---

## 🛠 Arquitetura & Tecnologias

**Arquitetura Serverless + Edge Computing**:

- **Frontend:** HTML5, CSS3 (Glassmorphism), JS ES6 Modules  
- **AI/CV:** MediaPipe FaceMesh (WebAssembly/WebGL)  
- **Backend:** Firebase  
  - Authentication  
  - Firestore (NoSQL)  
  - Firestore Security Rules  
- **Infra:** PWA com caching inteligente

### 🔄 Fluxo de Dados

1. **Captura:** Webcam → frame local  
2. **Processamento:** EAR/MAR/Pitch/Yaw em tempo real  
3. **Inferência:** Quebra de threshold → alerta local  
4. **Persistência:** Apenas metadados são enviados ao Firestore  
   > *Nenhuma imagem é salva ou enviada para a nuvem.*

---

## 🔐 Segurança e Privacidade (LGPD)

Desenvolvido seguindo *Privacy by Design*:

- **Processamento 100% local** (RAM → descarte imediato)  
- **LGPD Modal** explicando biometria e consentimento  
- **Security Rules avançadas**
  - Sem acesso para usuários não autenticados  
  - Operador só grava seus próprios logs  
  - ADMIN/OWNER têm leitura agregada  
  - Deleção apenas para OWNER  

---

## 📄 Licença

**Todos os direitos reservados.**  
Este software é proprietário, confidencial e protegido legalmente.  
É proibida qualquer forma de cópia, alteração, engenharia reversa ou distribuição sem autorização formal.

---

<div align="center">
  <sub>Desenvolvido por <a href="https://www.linkedin.com/in/jordanlvs">Jordan LVS</a> 🚀</sub>
</div>
