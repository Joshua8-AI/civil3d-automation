;;; ---------------------------------------------------------------------------
;;; Build a titled sheet: layout + viewport + border + title block + north arrow.
;;;
;;; Deliberately uses entmake + MVIEW rather than the .NET API. Creating and
;;; configuring a paper-space Viewport through .NET while that layout is current
;;; crashes the host (see docs/FINDINGS.md). MVIEW lets AutoCAD own the viewport.
;;;
;;; Handles both unit systems: imperial templates lay out paper space in INCHES,
;;; metric templates in MILLIMETRES. Geometry is authored in inches and scaled.
;;; ---------------------------------------------------------------------------

(defun c3d:log (s / f p)
  (setq p (strcat (getvar "TEMPPREFIX") "c3dsheet.out"))
  (setq f (open p "a")) (write-line s f) (close f) (princ))

(defun c3d:txt (x y h s)
  (entmake (list '(0 . "TEXT") '(8 . "0") (cons 10 (list x y 0.0)) (cons 40 h) (cons 1 s))))

(defun c3d:ln (x1 y1 x2 y2)
  (entmake (list '(0 . "LINE") '(8 . "0")
                 (cons 10 (list x1 y1 0.0)) (cons 11 (list x2 y2 0.0)))))

(defun c3d:box (x1 y1 x2 y2)
  (entmake (list '(0 . "LWPOLYLINE") '(100 . "AcDbEntity") '(8 . "0")
                 '(100 . "AcDbPolyline") '(90 . 4) '(70 . 1)
                 (cons 10 (list x1 y1)) (cons 10 (list x2 y1))
                 (cons 10 (list x2 y2)) (cons 10 (list x1 y2)))))

;; layout    - layout name to create/reuse
;; cx cy     - model coordinates to centre the viewport on
;; mpi       - MODEL UNITS per paper INCH  (imperial 1"=200' -> 200
;;                                          metric 1:100000 -> 0.0254*100000 = 2540 m)
;; title     - sheet title
;; subtitle  - second title-block line
;; who       - name / id line
;; scaletxt  - human readable scale for the title block
;; dwgno     - drawing number
(defun c3d:sheet (layout cx cy mpi title subtitle who scaletxt dwgno
                  / px py u mpu mg bx by tbh vy1 vy2 c1 c2 vh ax ay)

  (if (not (member layout (layoutlist)))
    (command "_.-LAYOUT" "_N" layout))

  ;; LIMMAX only refreshes when the layout is re-activated after a page-setup
  ;; change, so bounce through Model or you measure the OLD paper size.
  (setvar "CTAB" "Model")
  (setvar "CTAB" layout)
  (command "_.PSPACE")
  (command "_.REGEN")

  (setq px (car (getvar "LIMMAX"))
        py (cadr (getvar "LIMMAX")))
  (setq u   (if (> px 50.0) 25.4 1.0))     ; >50 means the sheet is in millimetres
  (setq mpu (/ mpi u))                      ; model units per PAPER unit
  (c3d:log (strcat "printable " (rtos px 2 2) " x " (rtos py 2 2)
                   (if (> u 1.0) " mm" " in")))

  (setq mg  (* 0.34 u))
  (setq bx  (- px mg) by (- py mg))
  (setq tbh (* 1.55 u))
  (setq vy1 (+ tbh (* 0.10 u))
        vy2 (- by  (* 0.10 u)))
  (setq vh  (* (- vy2 vy1) mpu))
  (setq c1  (* bx 0.62) c2 (* bx 0.83))

  ;; ERASE ALL from the command line cannot select paper-space viewport #1.
  ;; (Iterating the BlockTableRecord in .NET CAN, and erasing it corrupts the layout.)
  (command "_.ERASE" "_ALL" "")

  (c3d:box mg mg bx by)
  (c3d:box mg mg bx tbh)
  (c3d:ln mg (- tbh (* 0.40 u)) bx (- tbh (* 0.40 u)))
  (c3d:ln mg (- tbh (* 0.76 u)) bx (- tbh (* 0.76 u)))
  (c3d:ln c1 mg c1 (- tbh (* 0.76 u)))
  (c3d:ln c2 mg c2 (- tbh (* 0.76 u)))

  (c3d:txt (+ mg (* 0.08 u)) (- tbh (* 0.31 u)) (* 0.14 u) title)
  (c3d:txt (+ mg (* 0.08 u)) (- tbh (* 0.67 u)) (* 0.085 u) subtitle)
  (c3d:txt (+ mg (* 0.08 u)) (+ mg (* 0.29 u)) (* 0.095 u) who)
  (c3d:txt (+ c1 (* 0.07 u)) (+ mg (* 0.29 u)) (* 0.085 u) (strcat "SCALE:  " scaletxt))
  (c3d:txt (+ c2 (* 0.06 u)) (+ mg (* 0.29 u)) (* 0.085 u) "DWG NO:")
  (c3d:txt (+ c2 (* 0.06 u)) (+ mg (* 0.06 u)) (* 0.12 u) dwgno)

  (command "_.MVIEW"
           (strcat (rtos (+ mg (* 0.08 u)) 2 4) "," (rtos vy1 2 4))
           (strcat (rtos (- bx (* 0.08 u)) 2 4) "," (rtos vy2 2 4)))
  (command "_.MSPACE")
  (command "_.ZOOM" "_C" (strcat (rtos cx 2 4) "," (rtos cy 2 4)) (rtos vh 2 4))
  (command "_.PSPACE")
  (c3d:log (strcat "view height " (rtos vh 2 1)))

  ;; north arrow, kept well inboard so the "N" is not clipped by the border
  (setq ax (- bx (* 1.10 u)) ay (- vy2 (* 0.62 u)))
  (c3d:ln ax (+ ay (* 0.34 u)) (- ax (* 0.13 u)) (- ay (* 0.06 u)))
  (c3d:ln (- ax (* 0.13 u)) (- ay (* 0.06 u)) ax (+ ay (* 0.06 u)))
  (c3d:ln ax (+ ay (* 0.06 u)) (+ ax (* 0.13 u)) (- ay (* 0.06 u)))
  (c3d:ln (+ ax (* 0.13 u)) (- ay (* 0.06 u)) ax (+ ay (* 0.34 u)))
  (c3d:txt (- ax (* 0.05 u)) (+ ay (* 0.42 u)) (* 0.13 u) "N")

  (c3d:log "sheet done")
  (princ)
)
(princ "\nc3d:sheet loaded.")
(princ)
