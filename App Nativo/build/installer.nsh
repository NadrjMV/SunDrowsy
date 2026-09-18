; Watchdog do SunDrowsy: cria (na instalação) e remove (na desinstalação) uma Tarefa
; Agendada do Windows que checa a cada 1 minuto se o app está rodando e, se não
; estiver, religa sozinho. É o que garante que matar o processo pelo Gerenciador de
; Tarefas não deixa a estação sem monitoramento por muito tempo.
;
; A instalação é "por máquina" (perMachine, ver package.json), ou seja, roda elevada
; (UAC). Por isso a tarefa é registrada com /RU SYSTEM /RL HIGHEST: ela passa a rodar
; com privilégios de sistema, e um usuário padrão (conta de vigia, sem ser admin) não
; consegue apagá-la ou desativá-la pelo Agendador de Tarefas — precisaria de uma senha
; de administrador do Windows pra isso.

!macro customInstall
  DetailPrint "Configurando watchdog do SunDrowsy..."

  ; Gera o script (.vbs) que faz a checagem, já com o caminho real de instalação.
  FileOpen $9 "$INSTDIR\watchdog.vbs" w
  FileWrite $9 'Set objShell = CreateObject("WScript.Shell")$\r$\n'
  FileWrite $9 'Set objExec = objShell.Exec("tasklist /FI ""IMAGENAME eq SunDrowsy.exe"" /FO CSV /NH")$\r$\n'
  FileWrite $9 'strOutput = objExec.StdOut.ReadAll()$\r$\n'
  FileWrite $9 'If InStr(strOutput, "SunDrowsy.exe") = 0 Then$\r$\n'
  FileWrite $9 '    objShell.Run """$INSTDIR\SunDrowsy.exe""", 1, False$\r$\n'
  FileWrite $9 'End If$\r$\n'
  FileClose $9

  ; Remove uma tarefa antiga (ex: reinstalação/atualização) antes de recriar.
  nsExec::Exec 'schtasks /delete /tn "SunDrowsyWatchdog" /f'

  ; Roda a cada 1 minuto, como SYSTEM, com privilégio máximo — sobrevive a logoff
  ; e um usuário padrão não consegue remover.
  nsExec::Exec 'schtasks /create /tn "SunDrowsyWatchdog" /tr "wscript.exe \"$INSTDIR\watchdog.vbs\"" /sc MINUTE /mo 1 /ru SYSTEM /rl HIGHEST /f'
!macroend

!macro customUnInstall
  DetailPrint "Removendo watchdog do SunDrowsy..."
  nsExec::Exec 'schtasks /delete /tn "SunDrowsyWatchdog" /f'
  Delete "$INSTDIR\watchdog.vbs"
!macroend
