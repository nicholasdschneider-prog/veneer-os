/* Synthetic listener ports only; no business addresses or environment reads. */
#include <arpa/inet.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/socket.h>
#include <unistd.h>
static int attempt(int port, int type) {
  int fd=socket(AF_INET,type,0);
  if(fd<0) return errno;
  struct sockaddr_in a={0}; a.sin_family=AF_INET; a.sin_port=htons((unsigned short)port);
  inet_pton(AF_INET,"127.0.0.1",&a.sin_addr);
  int r;
  if(type==SOCK_STREAM) r=connect(fd,(struct sockaddr *)&a,sizeof(a));
  else r=(int)sendto(fd,"synthetic",9,0,(struct sockaddr *)&a,sizeof(a));
  int error=r<0?errno:0; close(fd); return error;
}
int main(int argc,char **argv) {
  if(argc!=3) return 64;
  printf("{\"allowedTcp\":%d,\"alternateTcp\":%d,\"alternateUdp\":%d}\n",
    attempt(atoi(argv[1]),SOCK_STREAM),attempt(atoi(argv[2]),SOCK_STREAM),attempt(atoi(argv[2]),SOCK_DGRAM));
  return 0;
}
