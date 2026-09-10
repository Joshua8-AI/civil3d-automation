;;; ---------------------------------------------------------------------------
;;; Plot a layout to PDF with -PLOT.
;;;
;;; Use the COMMAND, not PlotFactory/PlotEngine: the engine API is crash-prone
;;; when driven from a SendCommand context, whereas a wrong answer here just
;;; produces an error message.
;;;
;;; The prompt chain below was established empirically by logging LASTPROMPT
;;; after every token (see c3d:discover). Two prompts catch people out:
;;;   * "Scale lineweights with plot scale?"
;;;   * "Plot paper space FIRST?"     <- first, not last
;;; and with a PDF plotter there is NO "Write the plot to a file?" prompt --
;;; it asks for the filename directly. Miscount and every later answer shifts.
;;; ---------------------------------------------------------------------------

(defun c3d:plot-pdf (layout pdf paper units orient ctb / )
  ;; units  "_I" inches | "_M" millimetres   (match the layout's paper units)
  ;; orient "_P" portrait | "_L" landscape   (match the layout, don't fight it)
  (if (findfile pdf) (vl-file-delete pdf))
  (setvar "CMDECHO" 0)
  (setvar "FILEDIA" 0)
  (setvar "BACKGROUNDPLOT" 0)
  (setvar "CTAB" layout)
  (command "_.-PLOT"
           "_Y"          ; detailed plot configuration?
           layout        ; layout name
           "DWG To PDF.pc3"
           paper         ; e.g. "ANSI A (8.50 x 11.00 Inches)"
           units
           orient
           "_N"          ; plot upside down?
           "_L"          ; plot area = Layout
           "1:1"         ; plot scale (the viewport carries the drawing scale)
           "0.00,0.00"   ; plot offset
           "_Y"          ; plot with plot styles?
           ctb           ; e.g. "monochrome.ctb"
           "_Y"          ; plot with lineweights?
           "_N"          ; scale lineweights with plot scale?
           "_N"          ; plot paper space FIRST?
           "_N"          ; hide paperspace objects?
           pdf           ; file name  (no yes/no prompt precedes this for PDF devices)
           "_N"          ; save changes to page setup?
           "_Y")         ; proceed
  (if (findfile pdf) (princ "\nPDF written.") (princ "\nPDF MISSING."))
  (princ)
)

;;; If a future release changes the prompt order, rediscover it rather than guess:
;;; feed tokens one at a time and log what the command asks next.
(defun c3d:discover ( / p f)
  (setq p (strcat (getvar "TEMPPREFIX") "plotchain.out"))
  (defun pl (s) (setq f (open p "a")) (write-line s f) (close f))
  (command "_.-PLOT")
  (pl (strcat "opened -> " (vl-princ-to-string (getvar "LASTPROMPT"))))
  (princ "\nNow feed tokens with (command \"...\") and re-read LASTPROMPT.")
  (princ)
)
(princ "\nc3d:plot-pdf loaded.")
(princ)
