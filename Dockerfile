# El portal no tiene dependencias: SQLite viene dentro de Node 24 y el servidor
# es http nativo. Por eso no hay `npm install` en ninguna parte — no hay nada
# que instalar, y tampoco hay compiladores en la imagen que alguien pueda usar.
FROM node:24-alpine

# La app corre sin privilegios. La imagen de node ya trae este usuario.
WORKDIR /app
COPY package.json ./
COPY servidor ./servidor
COPY herramientas ./herramientas

# Los datos (base y clave privada) van en un volumen, nunca en la imagen: al
# actualizar el portal se reemplaza la imagen entera y la clave tiene que
# sobrevivir a eso.
ENV LAMPARA_DATOS=/datos
RUN mkdir -p /datos && chown -R node:node /datos
VOLUME ["/datos"]

USER node
ENV PORT=8099
EXPOSE 8099

HEALTHCHECK --interval=60s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8099)+'/salud').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "servidor/servidor.js"]
