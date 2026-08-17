#!/bin/sh
# Arranque del portal.
#
# Existe por una razón concreta: el volumen donde viven la base y la clave de
# firma lo crea quien despliega —TrueNAS lo entrega como root, 0755— y un
# contenedor con `USER node` fijo en la imagen no puede escribir ahí. El
# síntoma es "unable to open database file" en bucle, que no dice nada de
# permisos y cuesta un rato entender.
#
# Así que el dueño del volumen se decide al arrancar, no al construir la imagen:
# si venimos como root, se le pasa la carpeta al usuario `node` y se baja de
# privilegios antes de ejecutar el servidor. Si el que despliega ya fijó un
# usuario propio (TrueNAS lo permite), no se toca nada y se arranca tal cual —
# ahí él sabrá que la carpeta debe ser suya.
set -e

if [ "$(id -u)" = "0" ]; then
  chown -R node:node "${LAMPARA_DATOS:-/datos}"
  exec su-exec node "$@"
fi

exec "$@"
